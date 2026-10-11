#!/usr/bin/env bash
# Mirror NIH's DSLD full-database download into the backend's label store.
# Run weekly by dsa-dsld-mirror.timer (installed by deploy/autodeploy/install.sh).
#   - checks the download's ETag (one request) and stops if it was already imported
#   - needs 6 GB free; downloads the zip (~0.6 GB) with the api.data.gov key from settings.env
#   - streams one label at a time from the zip into the running backend (no unpacking to disk)
#   - deletes the zip afterwards
set -euo pipefail
SVC=/opt/pocket/services/dietary-supplement-analysis
DIR=$SVC/mirror
URL=https://api.ods.od.nih.gov/dsld/s3/data/DSLD-full-database-JSON.zip
BACKEND=dietary-supplement-analysis-backend
LOG=$DIR/mirror.log
mkdir -p "$DIR"
log(){ echo "$(date -u +%FT%TZ) $*" | tee -a "$LOG"; }

KEY=""
if [ -f "$SVC/settings.env" ]; then KEY=$(sed -n 's/^DSLD_API_KEY=//p' "$SVC/settings.env" | head -1); fi
HDR=(); [ -n "$KEY" ] && HDR=(-H "X-Api-Key: $KEY")

head=$(curl -sSIf "${HDR[@]}" "$URL") || { log "HEAD failed; will retry next run"; exit 0; }
etag=$(printf '%s' "$head" | sed -n 's/^etag: *//Ip' | tr -d '\r"')
lastmod=$(printf '%s' "$head" | sed -n 's/^last-modified: *//Ip' | tr -d '\r')
version="$lastmod (etag $etag)"

# What the running backend has imported (it reports the mirror in /v1/provenance).
current=$(docker exec "$BACKEND" node -e "fetch('http://127.0.0.1:8080/v1/provenance').then(r=>r.json()).then(j=>console.log((j.data.labels.mirror||{}).version||''))" 2>/dev/null || true)
if [ "$current" = "$version" ] && [ "${FORCE:-0}" != 1 ]; then log "up to date: $version"; exit 0; fi

free_gb=$(df -BG --output=avail "$DIR" | tail -1 | tr -dc 0-9)
if [ "${free_gb:-0}" -lt 6 ]; then log "only ${free_gb} GB free; need 6 GB. Not downloading."; exit 1; fi

log "downloading $version"
curl -sSf "${HDR[@]}" -o "$DIR/dsld.zip.part" "$URL"
mv "$DIR/dsld.zip.part" "$DIR/dsld.zip"
day=$(date -u -d "$lastmod" +%F 2>/dev/null || date -u +%F)

log "importing into $BACKEND"
python3 -I - "$DIR/dsld.zip" <<'PY' | docker exec -i "$BACKEND" node --disable-warning=ExperimentalWarning dist/src/tools/import-dsld.js /data/dsld.sqlite "$version" "$day" | tee -a "$LOG"
import json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
out = sys.stdout
for info in z.infolist():
    if info.is_dir() or not info.filename.endswith('.json'):
        continue
    try:
        doc = json.loads(z.read(info))
    except Exception:
        continue
    for label in (doc if isinstance(doc, list) else [doc]):
        out.write(json.dumps(label, separators=(',', ':')))
        out.write('\n')
PY
rm -f "$DIR/dsld.zip"
log "done; $(df -h --output=avail "$DIR" | tail -1 | tr -d ' ') free"
