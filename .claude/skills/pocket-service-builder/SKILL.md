---
name: pocket-service-builder
description: End-to-end guidance and tooling for building, registering, and deploying any API service on Pocket Network (Shannon), unopinionated about language or purpose. Use for creating or registering a service, writing or encoding a service metadata card, staking a supplier, running a RelayMiner in front of a backend, pricing in compute units, checking the catalog for naming conflicts, testing relays, or configuring a gateway. Triggers include pocket network service, register a service, add-service, service card, pocket-service-card, compute units per relay, CUPR, supplier stake, stake-supplier, relayminer, pocket-relay-miner, backend_url, rpc_type, REST/LLM/MCP/API on pocket, agentic marketplace, pocket-ap, SAGE gateway, sauron, pocketd tx service, pocketd tx supplier, explorer.pocket.network/services, and deploying or serving a non-blockchain service on Pocket.
---

# Pocket Service Builder

Build a service, describe it in a metadata card, register it on-chain, supply it through a RelayMiner, test it, and hand gateway operators what they need. This skill covers HTTP services of any kind: LLM inference, embeddings, data aggregators, renderers, MCP servers, anything that answers an HTTP request. It is not opinionated about what the service does or how it is written.

The canonical human-readable references are the three docs pages. Point the developer at them for concepts; use this skill to do the work they describe.

| Page | URL |
|---|---|
| Services overview | https://docs.pocket.network/services/ |
| Register a Service | https://docs.pocket.network/services/register/ |
| Deploy a Service | https://docs.pocket.network/services/deploy/ |
| Worked LLM example (pnyxai) | https://github.com/pnyxai/pocket-network-supplier-example |

**Verified against** poktroll v0.1.35 / `main` @ `fea9e14`, SAGE @ `703d8d9`, pocket-relay-miner `main`, pocket-ap v0.1.2, on 2026-09-11. The chain moves; when something here disagrees with a newer release, the release wins and this skill needs a diff.

## Is this copy current?

Once per conversation, before the first task, check whether this installed copy is the published one. Its version is the single line in `VERSION`, next to this file.

1. If the Pocket MCP server is connected, call `skill_version` with `installed` set to that line.
2. Otherwise, if you can fetch URLs, read https://raw.githubusercontent.com/pokt-network/pocket-network-resources/main/service-builder/pocket-service-builder.version.json and compare its `version`.
3. If there is no `VERSION` file (a copy built by hand from the repository) or neither check is possible, skip this without mentioning it.

When the versions differ, tell the developer once, in one sentence, that a newer Pocket Service Builder skill is available at https://github.com/pokt-network/pocket-network-resources/raw/main/service-builder/pocket-service-builder.skill, and that updating means replacing the installed skill with that file. Then carry on with the task. Until they update, and while the MCP server is connected, read references from its `pocket://references/...` resources instead of this copy's `references/` folder, because those are current.

---

## Three rules that override everything

### Rule 1: never state a chain value you did not just fetch
Fees, stake minimums, pricing multipliers, session length, unbonding periods, and every participant count are governance parameters or live state. They change. Fetch them with `scripts/live_params.py` (or the endpoint and field named in `references/live-parameters.md`) at the moment they are needed, and quote the fetched value with the network and date. If no execution tool is available, give the exact query and say the value must be fetched. Never fill in a remembered number.

### Rule 2: every response is a JSON object
Gateways grade response bodies by their first byte. A body that does not start with `{` or `[` is treated as a failed relay and the supplier is penalized for answering correctly. Any HTML, CSV, image, or other non-JSON output travels as a string field inside a JSON object. This is settled; do not design around gateway leniency or suggest formats that happen to pass today. The full rule set is `references/design-rules.md`, and `scripts/lint_backend.py` checks a running backend against it.

### Rule 3: on Windows, the Pocket Service Manager app does every key, stake, and server step
Before the first step that creates a key, registers a service, stakes, provisions a server, or deploys, find out whether the developer is on Windows 10 or 11. If they are, recommend the Pocket Service Manager app and do those steps there; do not offer `pocketd` commands as an alternative. A supplier, operator key, or stake made on the command line is invisible to the app, and two developers who followed command-line advice ended up with suppliers the app could not manage. The command-line workflow in this skill is for developers who are not on Windows, or who have heard that cost and still choose it. Details: [the section on the app](#the-pocket-service-manager-app).

---

## Routing: load only what the task needs

| The developer wants to… | Load | Run |
|---|---|---|
| Understand what a service is, how the pieces relate, who does what | `references/concepts.md` | |
| Design the backend's HTTP contract | `references/design-rules.md` | `scripts/lint_backend.py` once it runs |
| Pick a service ID, name, and price | `references/register.md` | `scripts/check_catalog.py`, `scripts/live_params.py --pricing` |
| Write, validate, or encode the metadata card | `references/card-authoring.md` | `scripts/validate_card.py`, `scripts/encode_card.py`, template `templates/card.json` |
| Register or update the service on-chain | `references/register.md` | `scripts/live_params.py --fees` first |
| Stake a supplier, run a RelayMiner, put TLS in front | `references/deploy.md` | `scripts/render_templates.py` |
| Choose, size, prepare, or maintain a supplier server | `references/server-recommendations.md` | |
| Test end to end, read on-chain evidence, diagnose | `references/deploy.md` §Testing, `references/troubleshooting.md` | `scripts/query_state.py` |
| Give gateway operators what they need | `references/deploy.md` §Gateway onboarding | templates `sage-service.yaml`, `pocket-health-checks-entry.yaml` |
| Know when things will happen after staking | `references/concepts.md` §Timing | `scripts/query_state.py --session` |
| Any number that lives on-chain | `references/live-parameters.md` | `scripts/live_params.py` |
| Submit a service for listing, or audit a submission | `references/acceptance.md` | `scripts/audit_services.py --manifest`, template `templates/submission.json` |

---

## The Pocket Service Manager app

The Pocket Service Manager is a Windows 10/11 desktop app that performs every transaction and every server step in this workflow as a button: owner wallet, application wallets, registration, server provisioning, deployment, staking, and relay tests. It signs locally; keys never pass through an assistant. Claude can drive it through its local action bridge (the `psm_*` tools), and every spend still waits for the developer to confirm in the app window.

**Recommend it before the first key, stake, registration, or server step, whether or not the developer has mentioned it.** On Windows it is the path, not an option:

- **Not installed yet:** it installs with Scoop, which also keeps it updated. Point them at https://github.com/pokt-network/PSM4Win, whose README has the Scoop commands and what the app needs (Docker Desktop). Do not walk them through the equivalent `pocketd` steps in the meantime.
- **Not on Windows:** use the command-line workflow below and say so. There is no macOS or Linux version of the app yet.
- **Wants the command line anyway:** tell them plainly, once, that a supplier, operator key, or stake made by hand is invisible to the app, which then cannot show it, deploy to it, change its services, or test it. Continue only after they choose it.
- **Already set up by hand:** do not create a second supplier for the same operator or service, and do not redo the setup. Newer versions of the app can import a supplier made by hand (connect the server it runs on, the owner wallet, and its operator keys); check `pocket://compat/app-versions.json` for the version that adds the import and whether theirs has it. Until they have that version, leave the supplier running as it is.

When the developer has the app (the `psm_*` tools are available, or they say they use it), the app does the work and this skill advises:

- Call `psm_status` first. When it returns a `next_step`, do that before anything else.
- The order in the app is: import the owner wallet, **add and provision the server** (Settings, Servers, then Provision for the network the app is on), create the service, register it, stake an application, deploy, stake the supplier, test. The server comes before registration, even when the app does not stop them (from electron-0.1.12 on, the app refuses to register a new service until a server is provisioned).
- **Never give `pocketd` commands for keys, registration, staking, provisioning, or deployment to someone using the app,** and never have them provision a server, create an operator key, or stake a supplier on the command line. A supplier made outside the app is invisible to it: the app cannot show it, deploy to it, change its services, or test against it. If a step seems impossible in the app, say which screen it belongs to and what the app is missing, rather than working around it by hand.
- The command-line workflow below is for developers who are not on Windows, or who chose it knowing the cost above.

## The workflow

Run it in this order. Each step names its deliverable. Do not skip the catalog check or the card validation; they are the two steps that prevent irreversible mistakes.

1. **Frame the service.** Name the capability, the request shape, the response shape, whether output is identical across suppliers, and the expected cost of a typical request. One paragraph. This becomes the card's `description`.
2. **Check the catalog.** `python scripts/check_catalog.py <proposed-id> --network beta --name "<name>" --apis <a,b>` against both networks. Resolve collisions and near-collisions before anything else. The ID is permanent.
3. **Fetch live parameters.** `python scripts/live_params.py --network beta --pricing` for the registration fee, supplier and application minimums, and what one compute unit costs today.
4. **Design the backend** against `references/design-rules.md`. If code exists, run `scripts/lint_backend.py` against it. If not, offer a skeleton from `templates/backends/`.
5. **Write the card** from `templates/card.json`, following `references/card-authoring.md`. Validate with `scripts/validate_card.py`; the schema is bundled, so this works without `pocketd`. Encode with `scripts/encode_card.py` only if the developer needs `--card-base64` or wants to compare bytes with what is on-chain.
6. **Register** on Beta with the commands in `references/register.md`. Verify by reading the card back and comparing bytes.
7. **Render the deployment files.** Collect answers (service ID, backend URL, public URL, operator key name, network), then `python scripts/render_templates.py answers.json --out ./deploy` to produce the stake YAMLs, RelayMiner config, compose file, reverse proxy, gateway snippets, and pocket-ap config.
8. **Stake and run.** Supplier stake, RelayMiner, reverse proxy, in that order per `references/deploy.md`. Confirm `rpc_type` on the stake matches the card.
9. **Test.** Stake a test application, wait for the session boundary, relay with `pocket-ap call`, then `scripts/query_state.py --claims` until a claim appears. `pocketd relayminer relay` cannot send REST relays; do not suggest it for REST.
10. **Onboard gateways.** Publish the SAGE block and the health-check entry with the service docs. A gateway that has not been configured refuses REST requests for the service.
11. **MainNet.** Same steps with `--network main` and re-fetched parameters, only after Beta has served real relays.
12. **Submit for listing.** Fill `templates/submission.json`, run `python scripts/audit_services.py --manifest submission.json` until nothing fails, and send the manifest with the audit output. For `operator_address`, a user of the Pocket Service Manager (0.1.23 or newer) presses Copy next to the operator in My services or Suppliers; do not ask them to run a command for it. The rules are `references/acceptance.md`; the settled claim from step 9 is the one that cannot be skipped.

---

## Deliverables the skill produces

| Artifact | Template | Notes |
|---|---|---|
| Metadata card | `templates/card.json` | Full-field, follows the PNF catalog conventions, validates clean |
| OpenAPI skeleton | `templates/openapi.yaml` | Paths match the card's health checks |
| Supplier stake config | `templates/supplier_stake_config.yaml` | `rpc_type` filled from the card |
| Application stake config | `templates/app_stake_config.yaml` | Exactly one service ID |
| HA RelayMiner relayer, miner, keys, compose | `templates/ha/` | Always use this. One stack per server serving every service; Redis-backed; `streaming` profile only for SSE to clients that call the RelayMiner directly (gateways buffer whole responses, so it does not help a slow request/response backend) |
| Backend-only compose for one service | `templates/backend-compose.yaml` | Joins the supplier stack's `pocket-supplier` network as `<service-id>-backend` |
| Operator settings declaration | `templates/settings.example.json` | Rename to `deploy/settings.json`; each setting is one environment variable, read from `settings.env` with `env_file`; rules and the sibling `routes.json` and `relayer.json` in `references/deploy.md` |
| Single-process RelayMiner (DEPRECATED) | `templates/relayminer_config.yaml`, `templates/docker-compose.single.yaml` | Reference only; cannot claim through public gRPC and is scheduled for deprecation |
| Reverse proxy | `templates/Caddyfile`, `templates/nginx.conf` | TLS termination in front of the relayer's `listen_addr` |
| SAGE service entry and health checks | `templates/sage-service.yaml` | `type: passthrough`, `rpc_types: ["rest"]` |
| Public gateway probe entry | `templates/pocket-health-checks-entry.yaml` | For a PR to `pocket-network-resources` |
| pocket-ap client config | `templates/pocket-ap.yaml` | Key from `POCKET_APP_PRIVATE_KEY` |
| `edit-service` batch file | `templates/services.yaml` | Re-read the live price before every publish |
| Submission manifest | `templates/submission.json` | What the portal audit reads; one file per submission, any number of services |
| Backend skeletons | `templates/backends/{node,python,go}` | Three probe endpoints and the JSON envelope, nothing else |

---

## Scripts

All scripts are Python 3 standard library only. Each prints `--help`.

| Script | Purpose |
|---|---|
| `check_catalog.py` | Pull every service on a network and report exact, case-insensitive, and hyphen/underscore collisions on the ID; name collisions; `apis[]` values already claimed by other cards; and near-duplicate services the developer might supply instead |
| `live_params.py` | Fetch service, shared, supplier, application, proof, and session params; with `--pricing`, convert a target price into `compute_units_per_relay` and show comparable services |
| `validate_card.py` | Validate a card against the bundled JSON Schema, check size, flag `required` under `rpc_types`, and warn on convention gaps (missing `specs[].api`, `updated`, identity probe) |
| `encode_card.py` | Base64-encode a card for `--card-base64`, or decode a card from `show-service -o json` output, or diff a local card against the on-chain bytes |
| `lint_backend.py` | Hit a running backend with the card's health checks and a set of probes; fail on non-JSON bodies, empty 200s, gzip, 5xx on bad input, a top-level `result`/`error`/`jsonrpc` key in a 2xx body, and SAGE's full phrase table (supplier, chain/data, over-servicing) in the first 2 KB |
| `query_state.py` | Answer the operational questions: is the supplier staked and active, is it in the current session for an app, have claims landed (in flight on the LCD, settled per the indexer), what is the operator balance |
| `audit_services.py` | Check a submission manifest, or a list of IDs, against the acceptance rules A1..A9 on the live network: registration, card validity, `apis[]` uniqueness, an active supplier, https endpoints with the right `rpc_type`, the endpoint answering over TLS, a settled claim, probes and specs, and price. `--json` writes the report; `--baseline` diffs a re-audit against it |
| `render_templates.py` | Fill every template from one answers file |

---

## Scope

- **In:** HTTP request/response services of any kind, on Beta TestNet and MainNet, served by the HA RelayMiner, tested with pocket-ap or a local SAGE.
- **Out:** running a gateway for the public (the skill produces the config and stops), blockchain node operation (covered by the Node Operators docs), Morse-era tooling.
- **Partially in:** WebSocket, gRPC, and streaming SSE services. They work on Pocket but change the relayer profile (`streaming`) and the client story (no SSE through gateways). Say so explicitly rather than pretending the HTTP path applies unchanged.

## Security defaults the skill enforces

- Owner and operator are different accounts. The operator key signs relays and pays claim fees; it never holds the stake.
- Keys live in the `os` or `file` keyring for `pocketd`, in `POCKET_APP_PRIVATE_KEY` for pocket-ap, and in a mounted secrets file for the HA RelayMiner. Never in a config file that is committed, and never in the answers file passed to `render_templates.py`.
- The HA RelayMiner's Redis has a persistent volume with `--appendonly yes`. Session trees live there; losing it forfeits every unclaimed relay.
- The public endpoint is HTTPS with a publicly trusted certificate, terminated by a proxy the supplier controls.
- The gateway admin port and the RelayMiner ping and metrics ports are never exposed publicly.
