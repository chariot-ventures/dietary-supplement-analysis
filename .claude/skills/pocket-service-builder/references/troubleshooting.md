# Troubleshooting

A decision tree for the failures a first deployment hits. Each row names the one query or log line that distinguishes the cause. Most "it's broken" reports are timing: a stake goes active only at the next session boundary, and a claim appears only after the session ends.

## Nothing is happening after I staked

| Symptom | Check | Cause and fix |
|---|---|---|
| No relays arriving | `query_state.py --session --app <app> --service <id> --supplier <op>` | If your supplier is NOT IN the session, the stake has not activated yet, or the app's session rolled before activation. Wait one full session and re-check. |
| Supplier not in any session | `query_state.py --supplier <op>` | Stake missing, wrong service_id, or unbonding. Confirm the stake exists and lists the service. |
| Still nothing after two sessions | app stake | The test app must be staked for exactly this service and funded. `query_state.py --balance <app>`. |

## The relay fails

| Symptom | Check | Cause and fix |
|---|---|---|
| pocket-ap: no endpoint / supplier | session query | Your supplier is not in the session (above), or its `rpc_type` does not match the request type. |
| Gateway returns 400 "unconfigured service" or refuses before session lookup | gateway config | The gateway has no `services[]` entry with `rpc_types: ["rest"]` for this service. Add `sage-service.yaml`. |
| RelayMiner logs 404 from backend | `backend_url` | The path join is wrong. `backend_url: http://h:8080/api` + `/v1/x` -> `/api/v1/x`. Mount the API at `/` or fix the prefix. |
| Relayer `/health` not 200, or backend marked unhealthy in logs | `curl :8081/health`, relayer logs | The backend `url` is unreachable from the relayer, or its `health_check.endpoint` does not answer 2xx. On compose, use the service name, not `127.0.0.1`. |
| Every relay rejected: "payload failed to unmarshal as RelayResponse" at the client, "response signer not configured" in the relayer log | relayer log at startup | The relayer has no signing key: the config's `keys` section is missing (it is `keys`, not `signing_keys`) or `supplier-keys.yaml` is unreadable by uid 1000. |
| Backend sees an empty POST body through the relayer but works with curl | backend request headers | Relay bodies arrive with `Transfer-Encoding: chunked` and no `Content-Length`. Decode chunked bodies (design rule 2). |
| Relay returns HTML/plain text and gets retried | `lint_backend.py` | The backend returns a non-JSON body. Wrap it in a JSON object (design rule 1). |
| 5xx passed through, unpaid | backend logs | The backend returns 5xx for a client error. Return 4xx with a JSON body instead (design rule 5). |
| Valid JSON answer retried anyway | first 2 KB of the raw body, `lint_backend.py` | A gateway phrase sits in the first 2 KB as a raw, case-insensitive substring: a supplier phrase (`timeout`, also inside `timeout_ms`; `bad gateway`, ...), a chain/data phrase (`block not found`, `is pruned`, ...), or an over-servicing phrase. Rename the field; `\u`-escape one letter of user-generated text there (design rule 6). |
| JSON answer graded a failed relay, or penalized as fabricated | top-level keys of the 2xx body | The body has a top-level `result`, `error`, or `jsonrpc` key, so SAGE grades it as JSON-RPC: `200 {"error": ...}` fails, `result` plus `error` is Fatal. Rename the field; send `{"error": ...}` only with a 4xx (design rule 1). |
| TLS handshake errors from a gateway | cert | Self-signed or untrusted certificate. Use a publicly trusted cert; some gateways refuse plaintext or raw-IP URLs entirely. |

## Intermittent 502 through a gateway or portal

A service that settles claims but returns 502 on *some* paid calls is failing transiently at the supplier or backend, not structurally. Confirm it works at all first: a settled claim (`query_state.py --claims --supplier <op>`, or the `audit_services` A7 fact) proves relays are going through and being paid, so registration, staking, session, and delegation are fine. Then chase the transient layer.

| Symptom | Check | Cause and fix |
|---|---|---|
| 502 UPSTREAM_ERROR on some paid calls; the service otherwise settles claims | settled claims exist, and only one supplier is staked (`service_status`) | No redundancy: with a single supplier, any one flaky relay surfaces as a 502 with nothing to absorb it. Stake a second supplier/endpoint (or run RelayMiner replicas) so one failure does not reach the caller. |
| 502s correlate with slow responses | the backend's real latency (the Service Manager's Test step times each probe's supplier round trip) vs the gateway's `relay_timeout` | A genuine backend call (web search, LLM, aggregation) outlasts the gateway's `relay_timeout`, which operators typically set between 10 and 30 s (design rule 7). The RelayMiner is not the limit: its `timeout_profile: fast` already allows 30 s, and `streaming` does not help a request/response service, because the gateway has given up first. Answer within about 10 s, or return a job handle at once and let the client poll for the result. Asking one gateway's operator to raise `relay_timeout` helps only on that gateway. |
| 502s correlate with the upstream erroring or rate-limiting | adapter logs on the *error* path | The success path returns JSON (it settles), but when a private upstream errors, times out, or 429s the adapter passes through a non-JSON body, an empty body, or a 5xx. Every response, error included, must be a JSON object starting with `{` (e.g. `{"error":{...}}`); a non-envelope failure is graded a failed relay -> 502 and penalizes the supplier (design rules 1 and 5). Retrying also worsens upstream rate-limits; bound the upstream call and return a clean JSON error. |
| Client-side `TypeError: Failed to execute 'fetch' ... Illegal invocation` before the wallet prompt, with no funds spent and no relay attempted | the browser, not the chain | A portal/front-end bug, not your service: `fetch` was called with a `this` that is not `window` (an aliased or destructured `const f = window.fetch; f(...)`, or `fetch` passed as a callback). Fix is `window.fetch(...)` or `fetch.bind(window)`. Nothing the supplier or service owner can change; report it to the portal team. |

To localize a single 502: take its timestamp and read the RelayMiner and adapter logs together. If the relay never reached the backend, it is the relay/session/timeout layer; if the backend answered with a non-2xx or non-JSON body, it is the adapter or its upstream.

## The claim does not settle

| Symptom | Check | Cause and fix |
|---|---|---|
| No claim after the session ended | `query_state.py --claims --supplier <op>` | The claim window opens `claim_window_open_offset_blocks` after session end. Wait for it. If still absent, check the miner log for "claims submitted"; if Redis was lost or restarted without persistence, the session trees are gone and those relays are unpaid. |
| Claim fails with "unexpected 'x-cosmos-block-height' header length; got 0" | RelayMiner type | You are running the deprecated single-process `pocketd relayminer` against a public gRPC endpoint that strips that header. Switch to the HA RelayMiner (`templates/ha/`). |
| Claim present, never paid | proof | A proof was required and missing. `query_state.py --proofs --supplier <op>`. A missing required proof forfeits the claim and burns `proof_missing_penalty`. |
| Operator "insufficient funds" in logs | `query_state.py --balance <op>` | The operator cannot pay the claim/proof tx fee. Top it up; claims and proofs are on-chain transactions. |
| Supplier disappeared from sessions | stake amount | Stake fell below `min_stake` (a missing-proof penalty can do this) and the supplier was force-unbonded. Re-stake. |

## Registration problems

| Symptom | Cause and fix |
|---|---|
| `out of gas in location: txSize` | Fixed `--fees` too small for a card-carrying tx. Use `--gas auto --gas-prices 1upokt --gas-adjustment 1.5`. |
| `add-service` rejected, not owner | Only the owner account can update a service. |
| Card validates locally but `validate-card` fails | The bundled schema is older than the installed `pocketd`. Trust `pocketd`; then diff the schemas. |
| `edit-service` did nothing | The card and price already match on-chain byte-for-byte. `encode_card.py diff` confirms. Reformatting counts as a change. |
| Card update seemed to wipe the card | It did not; omitting `--card-file` preserves it. If you published `{}` you erased the content. Re-publish the full card. |

## Setting up the server in the Pocket Service Manager

| Symptom | Cause and fix |
|---|---|
| Provision stops at "Operator public key on chain" after about five minutes, saying the self-transfer was accepted but its inclusion was not seen | App 0.1.14 or earlier. The transfer worked and the key is on chain; the step looked for a field name pocketd 0.1.35 no longer prints, so it never saw its own success. Press Start provisioning again: it resumes, finds the key, and carries on. Updating the app to 0.1.15 or later fixes it for the next server. |

## When to escalate past this skill

- WebSocket, gRPC, or SSE streaming behaving oddly: these are partially in scope; the RelayMiner and gateway handling differ. See the HA RelayMiner docs.
- Anything about the protocol's own behavior (settlement math, tokenomics, session assignment internals) belongs to the `pocket-engineering` skill and the protocol docs, not here.
