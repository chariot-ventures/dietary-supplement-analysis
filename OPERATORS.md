# Operating dietary-supplement-analysis

A runbook for suppliers who serve the Pocket Network service `dietary-supplement-analysis`, and for gateway operators who route to it. Consumers should read the [README](README.md).

| | |
|---|---|
| Service ID | `dietary-supplement-analysis` |
| RPC type | `REST` (RelayMiner backend key `rest`) |
| Backend | This repository's container, Node.js 22, listening on port 8080, mounted at `/` |
| Results | `variable`: live label data from the NIH Dietary Supplement Label Database (DSLD) can change between calls and suppliers |
| Card | [card/card.json](card/card.json) |
| API spec | [openapi/openapi.json](openapi/openapi.json), also served by the backend at `GET /openapi.json` |

## Requirements

- **Host:** 1 GB of RAM and 2 GB of disk for the backend alone (the label store grows to a few hundred MB). On a supplier host, size the box for the RelayMiner stack (relayer, miner, Redis) as Pocket's server guidance describes. The backend container is limited to 512 MB.
- **Outbound HTTPS to `api.ods.od.nih.gov`.** This is the only network dependency. Nutrient reference data ships inside the image.
- **No inbound ports.** The backend is reached only by the relayer over the supplier's private Docker network.
- **No credentials.** The backend never reads caller headers or expects auth. Gateways drop caller headers anyway.

## Run the backend

On the supplier host, next to the HA RelayMiner stack (`pocket-supplier` Docker network):

```bash
git clone --branch release https://github.com/micallb/dietary-supplement-analysis /opt/pocket/services/dietary-supplement-analysis/backend
mkdir -p /opt/pocket/services/dietary-supplement-analysis/deploy
cd /opt/pocket/services/dietary-supplement-analysis/deploy
```

Create `docker-compose.yaml` here:

```yaml
services:
  backend:
    build: ../backend
    image: dietary-supplement-analysis-backend:0.3.0
    container_name: dietary-supplement-analysis-backend
    restart: unless-stopped
    expose:
      - "8080"
    environment:
      LOG_LEVEL: info
      # DSLD_API_KEY: ""            # optional; sent to DSLD as X-Api-Key
      # DSLD_PREWARM_IDS: "230932,338022,332278"
    mem_limit: 512m
    volumes:
      - dsld-store:/data # persistent label store
    networks: [supplier]

volumes:
  dsld-store:

networks:
  supplier:
    external: true
    name: pocket-supplier
```

Then start it:

```bash
docker compose -p dietary-supplement-analysis up -d --build
docker exec dietary-supplement-analysis-backend node -e "fetch('http://127.0.0.1:8080/v1/version').then(r=>r.text()).then(console.log)"
# {"service":"dietary-supplement-analysis","version":"0.3.0"}
```

The image runs as a non-root user and has a Docker `HEALTHCHECK` on `/v1/health`.

### Settings

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listen address |
| `LOG_LEVEL` | `info` | Each log line holds method, path, status and duration only. Request bodies (age, sex, a person's supplements) and query strings are never logged. |
| `DSLD_API_KEY` | none | Optional key sent to DSLD as `X-Api-Key` |
| `DSLD_BASE_URL` | `https://api.ods.od.nih.gov/dsld/v9` | DSLD API base |
| `DSLD_PREWARM_IDS` | none | Comma-separated label IDs to cache at startup |
| `DSLD_STORE_PATH` | `/data/dsld.sqlite` in the container, off otherwise | Persistent label store (SQLite). Every fetched label is kept; when NIH is unreachable, labels, barcodes and searches are answered from it. Empty turns it off |
| `DSLD_WARM` | `1` | With the store on, a background job fetches popular products into it at about one request per second (queries in [data/warm-queries.json](data/warm-queries.json)). `0` turns it off |
| `UPSTREAM_BUDGET_MS` | `8000` | Total time one request may wait on DSLD before answering `424 UPSTREAM_UNAVAILABLE` |

Do not set `DSLD_FIXTURES_DIR` in production; it serves test fixtures instead of live data.

## RelayMiner configuration

Add the service to the HA relayer's `services:` block, then recreate the relayer (`docker compose -p pocket-supplier up -d --force-recreate relayer`):

```yaml
services:
  dietary-supplement-analysis:
    timeout_profile: fast
    max_body_size_bytes: 20971520
    default_backend: rest
    backends:
      rest:
        url: "http://dietary-supplement-analysis-backend:8080"
        health_check:
          endpoint: "/v1/health"
          interval_seconds: 10
          timeout_seconds: 5
```

Stake the supplier with `rpc_type: REST` for `dietary-supplement-analysis`, using an `https://` endpoint with a publicly trusted certificate, terminated by your reverse proxy (Caddy or nginx) in front of the relayer.

## Health checks

These match the card's `serving.healthcheck`. All three are cheap and need no upstream call.

| Probe | Request | Expect |
|---|---|---|
| Identity | `GET /v1/version` | `$.service` matches `^dietary-supplement-analysis$` |
| Readiness | `GET /v1/health` | `$.status` matches `^ok$` |
| Functional | `POST /v1/nutrients/reference` with `{"nutrient":"vitamin-d","age":30,"sex":"female"}` | `$.nutrient.id` matches `^vitamin-d$` |

`GET /` and `HEAD /` also return 2xx JSON, for RelayMiner reachability checks.

## Gateway operators (SAGE)

Gateways do not read the card. Add this entry, or SAGE refuses REST requests for the service:

```yaml
gateway_config:
  services:
    - id: dietary-supplement-analysis
      type: passthrough
      rpc_types: ["rest"]
      timeout_config:
        relay_timeout: 30s
  active_health_checks:
    local:
      - service_id: dietary-supplement-analysis
        enabled: true
        checks:
          - name: version
            type: rest
            method: GET
            path: /v1/version
            expected_status_code: 200
            reputation_signal: critical_error
            timeout: 5s
          - name: health
            type: rest
            method: GET
            path: /v1/health
            expected_status_code: 200
            reputation_signal: major_error
            timeout: 5s
        # No sync_check or sync_allowance: this is not a blockchain service.
```

## What the backend guarantees

These rules come from Pocket's gateway design rules, and the test suite checks each one:

- **Response bodies:** every body, errors included, is a JSON object. A 2xx body never has a top-level `result`, `error` or `jsonrpc` key.
- **Status codes:** client errors are 4xx with `{"error":{"code","message","retryable","field"}}`. The backend never returns 5xx.

  | Code | Status | When |
  |---|---|---|
  | `INVALID_INPUT` | 400 | Malformed or out-of-range input |
  | `NOT_FOUND` | 404 | Unknown DSLD ID, nutrient or route |
  | `UNSUPPORTED` | 422 | Pregnancy or lactation outside ages 14-50 |
  | `UPSTREAM_UNAVAILABLE` | 424, `retryable: true` | DSLD can't be reached and nothing is cached |
  | `INTERNAL_ERROR` | 422 | Unexpected failure |

- **Gateway error phrases:** text that SAGE treats as an error signal ("timeout", "block not found", "connection refused" and others) is `\u`-escaped in response bytes, including product names and echoed queries. It decodes to the identical string.
- **Encoding and parsing:** responses are not compressed. Request bodies may be chunked with no `Content-Length`, and are parsed as JSON whatever the `Content-Type`.
- **Latency:** at most 4 DSLD calls run at a time, each with a 6 s deadline, inside an 8 s budget per request. Labels are cached in memory for 7 days and searches for 24 hours, and kept in the persistent label store (mount a volume at `/data`). If DSLD is down, stale copies and the label store answer instead. Measured against live DSLD: a cold 15-product analyze took 1.5 s and a warm one 17 ms.

## Reference deployment

The first supplier runs on one Oracle Cloud Always Free ARM VM (1 OCPU, 4 GB RAM), set up by
[deploy/provision-beta.sh](deploy/provision-beta.sh). That script covers Docker, swap and firewall, this backend, an operator key
created on the server, the HA RelayMiner stack (`pocket-relay-miner:v0.1.0`, Redis `8.10.1-alpine`) and Caddy for TLS, with a per-client rate limit on the public demo route. Backend releases deploy themselves from tags (see [Automatic upgrades](#automatic-upgrades-from-release-tags)).
The staking configs are in [deploy/beta-stake/](deploy/beta-stake/), and the transactions, including a settled claim, are
in [deploy/PHASE4_READINESS.md](deploy/PHASE4_READINESS.md). For relay-miner v0.1.0, leave `pocket_node.chain_id` out of the
relayer config and use `logging.format` without `logging.output` in the miner config. Validation rejects both.

## Check a deployment

From a machine that can reach the backend (for example on the host, port-forwarded), run Pocket's linter from the Service Builder skill:

```bash
python .claude/skills/pocket-service-builder/scripts/lint_backend.py \
  --base-url http://127.0.0.1:8080 --card card/card.json \
  --probe 'POST /v1/stack/analyze {"products":[{"dsld_id":230932}]}' \
  --bad 'POST /v1/stack/analyze notjson'
```

Every check should pass. Then send relays through Pocket with `pocket-ap` and compare them with direct calls.

## Upgrades

Image versions follow the card's `serving.implementations` (`dietary-supplement-analysis >= 0.3.0`). To upgrade by hand, check out the new tag in `backend/` and run `docker compose -p dietary-supplement-analysis up -d --build`. The health check paths and the response contract stay stable within 0.x; fields are added, not renamed (0.2.0 replaced the `below_reference` flag with `coverage`, see [CHANGELOG.md](CHANGELOG.md)). A breaking change would ship under a new service ID or a new `apis[]` value.

### Automatic upgrades from release tags

[deploy/autodeploy/](deploy/autodeploy/) makes a supplier follow this repository's releases with no manual step:

```bash
curl -fsSL https://raw.githubusercontent.com/micallb/dietary-supplement-analysis/main/deploy/autodeploy/install.sh | sudo bash
```

It installs a systemd timer that checks GitHub every 5 minutes for the newest release: the highest `vX.Y.Z` tag, or the head of the `release` branch when its `package.json` carries a higher version (set `TRACK` in `/etc/dsa-autodeploy.env` to change this, for example `TRACK=branch:main`). A new release is built, smoke-tested in a throwaway container (`/v1/version` must report the release's version, and `/v1/health` and the card's functional probe must pass), then swapped in with the compose file from that release. If the live container fails the same checks, the previous image is restored and the release is marked failed so it isn't retried. Only the backend container changes; the RelayMiner, Redis, Caddy and on-chain state are untouched. Logs: `journalctl -u dsa-autodeploy` and `/opt/pocket/services/dietary-supplement-analysis/autodeploy/deploy.log`.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `424 UPSTREAM_UNAVAILABLE` on product and stack routes, while `/v1/nutrients/reference` works | The host can't reach `api.ods.od.nih.gov` over HTTPS, or DSLD is down. Check egress and DNS from inside the container. |
| Relayer marks the backend unhealthy | Wrong backend URL or Docker network. The container must be on `pocket-supplier` and named `dietary-supplement-analysis-backend`. |
| Gateway returns 400 for every REST request | The gateway lacks the SAGE entry above. |
| Responses differ between suppliers | Expected: DSLD data and the `as_of` and `retrieved` dates change. The card declares `results: variable`. |
