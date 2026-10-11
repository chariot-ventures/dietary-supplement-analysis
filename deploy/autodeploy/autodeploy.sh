#!/usr/bin/env bash
# Deploy the newest vX.Y.Z release tag of the backend, if it isn't running yet.
#
# Runs every few minutes from dsa-autodeploy.timer (installed by install.sh). Steps:
#   1. Find the highest vX.Y.Z tag on GitHub (git ls-remote; no API token needed).
#   2. If it's newer than the deployed tag and hasn't failed before, check it out and build an image.
#   3. Smoke-test the image in a throwaway container: /v1/version must report the tag's version,
#      /v1/health must be ok, and the card's functional probe (/v1/nutrients/reference) must answer.
#   4. Swap the live container using the compose file from the tagged checkout, then re-check.
#      If the live check fails, roll back to the previous image and mark the tag as failed.
#
# Only the backend container changes. The relayer, miner, Redis and Caddy are untouched,
# so on-chain state (stakes, service config) never changes from here.
set -euo pipefail

SERVICE_ID=dietary-supplement-analysis
REPO=${REPO:-https://github.com/micallb/dietary-supplement-analysis.git}
SVC=${SVC:-/opt/pocket/services/$SERVICE_ID}
STATE=$SVC/autodeploy
SRC=$SVC/backend
IMAGE=$SERVICE_ID-backend
CONTAINER=$SERVICE_ID-backend
LOCK=/run/dsa-autodeploy.lock

mkdir -p "$STATE"
exec 9>"$LOCK"
flock -n 9 || { echo "another run is in progress"; exit 0; }

log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$STATE/deploy.log"; }

probe() { # probe <container> <expected-version>: exit 0 when all three checks pass
  docker exec "$1" node -e "
    const want = process.argv[1];
    const get = (p, init) => fetch('http://127.0.0.1:8080' + p, init).then(r => r.json());
    (async () => {
      const v = await get('/v1/version');
      if (v.service !== '$SERVICE_ID' || v.version !== want) throw new Error('version ' + JSON.stringify(v));
      const h = await get('/v1/health');
      if (h.status !== 'ok') throw new Error('health ' + JSON.stringify(h));
      const r = await get('/v1/nutrients/reference', { method: 'POST', body: JSON.stringify({ nutrient: 'vitamin-d', age: 30, sex: 'female' }) });
      if (r.nutrient?.id !== 'vitamin-d') throw new Error('reference ' + JSON.stringify(r).slice(0, 200));
    })().then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });
  " "$2"
}

wait_probe() { # wait_probe <container> <expected-version>
  for _ in $(seq 1 30); do
    probe "$1" "$2" 2>/dev/null && return 0
    sleep 2
  done
  probe "$1" "$2" # one last time, showing the error
}

latest=$(git ls-remote --tags --refs "$REPO" 'v*' | awk '{print $2}' | sed 's#refs/tags/##' \
  | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1 || true)
[ -n "$latest" ] || { log "no release tags found"; exit 0; }

current=$(cat "$STATE/deployed-tag" 2>/dev/null || echo none)
[ "$latest" = "$current" ] && exit 0
if grep -qxF "$latest" "$STATE/failed-tags" 2>/dev/null; then exit 0; fi

version=${latest#v}
log "deploying $latest (running: $current)"

if [ -d "$SRC/.git" ]; then
  git -C "$SRC" fetch -q --depth 1 origin "refs/tags/$latest:refs/tags/$latest"
  git -C "$SRC" checkout -q --detach "$latest"
else
  git clone -q --depth 1 --branch "$latest" "$REPO" "$SRC"
fi
log "source $(git -C "$SRC" log -1 --format='%h %s' | cut -c1-80)"

if ! docker build -q -t "$IMAGE:$latest" "$SRC" >/dev/null; then
  log "build failed for $latest"; echo "$latest" >> "$STATE/failed-tags"; exit 1
fi

# Smoke test in a throwaway container with no published ports.
cand=$SERVICE_ID-candidate
docker rm -f "$cand" >/dev/null 2>&1 || true
docker run -d --name "$cand" --memory 512m "$IMAGE:$latest" >/dev/null
if ! wait_probe "$cand" "$version"; then
  log "smoke test failed for $latest"; docker logs --tail 20 "$cand" 2>&1 | tee -a "$STATE/deploy.log" || true
  docker rm -f "$cand" >/dev/null; echo "$latest" >> "$STATE/failed-tags"; exit 1
fi
docker rm -f "$cand" >/dev/null

# Swap the live container. The compose file comes from the tagged checkout, so the repo controls it.
COMPOSE=$SRC/deploy/autodeploy/backend-compose.yaml
[ -f "$COMPOSE" ] || COMPOSE=/usr/local/share/dsa-autodeploy/backend-compose.yaml # tags older than the auto-deploy
previous=$(docker inspect --format '{{.Config.Image}}' "$CONTAINER" 2>/dev/null || echo "")
export BACKEND_IMAGE="$IMAGE:$latest"
docker compose -p "$SERVICE_ID" -f "$COMPOSE" up -d --remove-orphans >/dev/null 2>&1

if wait_probe "$CONTAINER" "$version"; then
  echo "$latest" > "$STATE/deployed-tag"
  log "live: $latest"
  # Keep the two newest backend images; drop older ones.
  docker images "$IMAGE" --format '{{.Tag}}' | grep -E '^v' | sort -V | head -n -2 | xargs -r -I{} docker rmi "$IMAGE:{}" >/dev/null 2>&1 || true
  exit 0
fi

log "live check failed for $latest; rolling back to ${previous:-nothing}"
echo "$latest" >> "$STATE/failed-tags"
if [ -n "$previous" ]; then
  export BACKEND_IMAGE="$previous"
  docker compose -p "$SERVICE_ID" -f "$COMPOSE" up -d >/dev/null 2>&1 || true
fi
exit 1
