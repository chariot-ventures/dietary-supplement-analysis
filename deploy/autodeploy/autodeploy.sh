#!/usr/bin/env bash
# Deploy the newest release of the backend, if it isn't running yet.
#
# What counts as "the newest release" is set in /etc/dsa-autodeploy.env (TRACK=...):
#   TRACK=tags              the highest vX.Y.Z tag on GitHub (the default)
#   TRACK=branch:release    the head of a branch (here: "release")
# With TRACK=tags, if TRACK_FALLBACK_BRANCH is set and that branch's head carries a higher
# package.json version than the newest tag, the branch head is deployed instead. That lets a
# release be cut by pushing to a branch when tags can't be pushed.
#
# Runs every few minutes from dsa-autodeploy.timer (installed by install.sh). Steps:
#   1. Resolve the release to a commit (git ls-remote; no API token needed).
#   2. If that commit isn't deployed and hasn't failed before, check it out and build an image.
#   3. Smoke-test the image in a throwaway container: /v1/version must report the version in that
#      commit's package.json, /v1/health must be ok, and the card's functional probe must answer.
#   4. Swap the live container using the compose file from that commit, then re-check.
#      If the live check fails, roll back to the previous image and mark the commit as failed.
#
# Only the backend container changes. The relayer, miner, Redis and Caddy are untouched,
# so on-chain state (stakes, service config) never changes from here.
set -euo pipefail

SERVICE_ID=dietary-supplement-analysis
[ -f /etc/dsa-autodeploy.env ] && . /etc/dsa-autodeploy.env
REPO=${REPO:-https://github.com/micallb/dietary-supplement-analysis.git}
TRACK=${TRACK:-tags}
TRACK_FALLBACK_BRANCH=${TRACK_FALLBACK_BRANCH:-}
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

# Version in package.json at a remote commit, via a shallow fetch into the checkout.
fetch_commit() { # fetch_commit <ref>: leaves the commit at FETCH_HEAD in $SRC
  if [ ! -d "$SRC/.git" ]; then git clone -q --depth 1 "$REPO" "$SRC"; fi
  git -C "$SRC" fetch -q --depth 1 origin "$1"
}
version_at() { git -C "$SRC" show "$1:package.json" | sed -n 's/^  "version": "\(.*\)",$/\1/p' | head -1; }

# ---- 1. resolve the release to a commit ----
label="" sha=""
case "$TRACK" in
  tags)
    tag=$(git ls-remote --tags --refs "$REPO" 'v*' | awk '{print $2}' | sed 's#refs/tags/##' \
      | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1 || true)
    if [ -n "$tag" ]; then
      sha=$(git ls-remote "$REPO" "refs/tags/$tag^{}" | awk '{print $1}')
      [ -n "$sha" ] || sha=$(git ls-remote "$REPO" "refs/tags/$tag" | awk '{print $1}')
      label=$tag
    fi
    if [ -n "$TRACK_FALLBACK_BRANCH" ]; then
      bsha=$(git ls-remote "$REPO" "refs/heads/$TRACK_FALLBACK_BRANCH" | awk '{print $1}')
      if [ -n "$bsha" ] && [ "$bsha" != "$sha" ]; then
        fetch_commit "refs/heads/$TRACK_FALLBACK_BRANCH"
        bver=$(version_at FETCH_HEAD)
        if [ -z "$tag" ] || [ "$(printf '%s\n%s\n' "${tag#v}" "$bver" | sort -V | tail -1)" = "$bver" ] && [ "$bver" != "${tag#v}" ]; then
          sha=$bsha label="$TRACK_FALLBACK_BRANCH@v$bver"
        fi
      fi
    fi
    ;;
  branch:*)
    branch=${TRACK#branch:}
    sha=$(git ls-remote "$REPO" "refs/heads/$branch" | awk '{print $1}')
    label="$branch@${sha:0:7}"
    ;;
  *) log "unknown TRACK=$TRACK"; exit 1 ;;
esac
[ -n "$sha" ] || { log "nothing to deploy for TRACK=$TRACK"; exit 0; }

current=$(cat "$STATE/deployed-sha" 2>/dev/null || echo none)
[ "$sha" = "$current" ] && exit 0
if grep -qxF "$sha" "$STATE/failed-shas" 2>/dev/null; then exit 0; fi

# ---- 2. check out and build ----
fetch_commit "$sha" 2>/dev/null || fetch_commit "${label%%@*}" # some servers refuse fetching a bare SHA
git -C "$SRC" checkout -q --detach "$sha"
version=$(version_at HEAD)
tagname=v$version-${sha:0:7}
log "deploying $label ($sha, version $version; running: $(cat "$STATE/deployed-label" 2>/dev/null || echo none))"
log "source $(git -C "$SRC" log -1 --format='%h %s' | cut -c1-80)"

if ! docker build -q --build-arg GIT_COMMIT="$sha" -t "$IMAGE:$tagname" "$SRC" >/dev/null; then
  log "build failed for $label"; echo "$sha" >> "$STATE/failed-shas"; exit 1
fi

# ---- 3. smoke test in a throwaway container with no published ports ----
cand=$SERVICE_ID-candidate
docker rm -f "$cand" >/dev/null 2>&1 || true
docker run -d --name "$cand" --memory 512m -e DSLD_WARM=0 -e DSLD_STORE_PATH= "$IMAGE:$tagname" >/dev/null
if ! wait_probe "$cand" "$version"; then
  log "smoke test failed for $label"; docker logs --tail 20 "$cand" 2>&1 | tee -a "$STATE/deploy.log" || true
  docker rm -f "$cand" >/dev/null; echo "$sha" >> "$STATE/failed-shas"; exit 1
fi
docker rm -f "$cand" >/dev/null

# ---- 4. swap the live container; the compose file comes from the release itself ----
COMPOSE=$SRC/deploy/autodeploy/backend-compose.yaml
[ -f "$COMPOSE" ] || COMPOSE=/usr/local/share/dsa-autodeploy/backend-compose.yaml # releases older than the auto-deploy
previous=$(docker inspect --format '{{.Config.Image}}' "$CONTAINER" 2>/dev/null || echo "")
export BACKEND_IMAGE="$IMAGE:$tagname"
docker compose -p "$SERVICE_ID" -f "$COMPOSE" up -d --remove-orphans >/dev/null 2>&1

if wait_probe "$CONTAINER" "$version"; then
  echo "$sha" > "$STATE/deployed-sha"
  echo "$label" > "$STATE/deployed-label"
  log "live: $label (version $version)"
  # Keep the three newest release images; drop older ones.
  docker images "$IMAGE" --format '{{.CreatedAt}}\t{{.Tag}}' | sort -r | awk -F'\t' '$2 ~ /^v/ {print $2}' | tail -n +4 \
    | xargs -r -I{} docker rmi "$IMAGE:{}" >/dev/null 2>&1 || true
  exit 0
fi

log "live check failed for $label; rolling back to ${previous:-nothing}"
echo "$sha" >> "$STATE/failed-shas"
if [ -n "$previous" ]; then
  export BACKEND_IMAGE="$previous"
  docker compose -p "$SERVICE_ID" -f "$COMPOSE" up -d >/dev/null 2>&1 || true
fi
exit 1
