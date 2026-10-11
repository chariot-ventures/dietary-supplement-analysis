# Phase 4 readiness (Beta TestNet)

Read-only checks run on 2026-10-11 with the Pocket Service Builder skill (v72dd5056ff1f, current).
Chain values are governance parameters: re-run `live_params.py` before acting on them.

| Check | Result |
|---|---|
| `check_catalog.py dietary-supplement-analysis --network beta` | Free of conflicts (128 services on Beta). MainNet not checked yet. |
| `service.add_service_fee` | 1,000 POKT |
| `supplier.min_stake` | 59,500 POKT |
| `application.min_stake` | 1,000 POKT |
| `shared.num_blocks_per_session` | 20 |
| `shared.supplier_unbonding_sessions` | 86 |
| One compute unit | 0.04 uPOKT |
| Price | 500 compute units per relay (20 uPOKT), in line with other data services on Beta |
| Faucet (`faucet.beta.pocket.network/config.json`) | 100,000 POKT per claim, 2 claims per address per 24 h |
| `validate_card.py card/card.json` | Schema OK, 3,474 bytes |
| `lint_backend.py` against the backend on live DSLD | 15/15 passed |

## Before registering

- [x] Merge to `main` and tag `v0.1.0` (done 2026-10-11).
- [x] Write `OPERATORS.md` (the card's `serving.docs`).
- [x] GitHub repo is public: the card's spec, docs and operator links (`main` and `v0.1.0`) load
      without a login (checked 2026-10-11).
- [x] DRI values in `data/source/manual.json` checked against the NIH ODS fact sheets in a browser
      (2026-10-11): every RDA, AI and UL for ages 1+ matches. The fact sheets do not print EARs, so those
      were not checked there. Fixed one conversion: 1 IU supplemental beta-carotene = 0.3 mcg RAE (was 0.15).
- [x] Server: Oracle Cloud Always Free, `VM.Standard.A1.Flex` (1 Ampere OCPU, 4 GB RAM, 50 GB boot volume),
      Ubuntu 24.04, us-ashburn-1, public IP `150.136.218.205`. Provisioned with
      [`deploy/provision-beta.sh`](provision-beta.sh) (Docker, swap, firewall, backend, operator key, HA RelayMiner, Caddy).
- [x] DNS (Porkbun, `trackmysupplement.com`): `pokt-beta.trackmysupplement.com` (relay endpoint, staked) and
      `agents.trackmysupplement.com` (direct demo route for judges) both point at the server; Caddy serves TLS for each.
- [x] Owner, operator and application keys created on the owner's Mac with `deploy/macos-keys.sh`
      (pocketd 0.1.35, passphrase-protected key file); addresses in `deploy/beta-addresses.json`.
      Each funded with 100,000 POKT from the Beta faucet on 2026-10-11:
      owner `88161BFA…FACC1C` (height 722333), operator `6CE7C10D…AB3F69C` (722334),
      application `B64D18A2…139C4524` (722336). All three succeeded (code 0).

## Done on Beta TestNet

| Step | Tx hash | Height | Result |
|---|---|---|---|
| Register `dietary-supplement-analysis`, 500 CU/relay, card from `card/card.json` (owner `dsa-owner`) | `BC01B11FFF4100473B84D483026F266111CF73CE9B07584E3083EDCF19B47DD5` | 722359 | code 0; on-chain card is byte-identical to `card/card.json` (3,474 bytes, SHA-256 `e9dde0dd…25eae79a`). Fee 1,000 POKT + ~0.33 POKT gas. |

## Order followed (skill workflow steps 6-9)

1. `pocketd tx service add-service dietary-supplement-analysis "Dietary Supplement Label and Nutrient Intake Analysis" 500 --card-file ./card/card.json --from <owner> --network=beta ...`, then read the card back with `encode_card.py diff`.
2. `render_templates.py answers.json --out ./deploy` for stake configs, HA RelayMiner, Caddy, SAGE and pocket-ap files.
3. Stake the supplier (`rpc_type: REST`), start the RelayMiner, put Caddy in front, stake the test application.
4. Wait for the session boundary, relay with `pocket-ap call`, then `query_state.py --claims` until a claim settles.

The supplier's operator key was created on the server instead of using the Mac's `dsa-operator` key, so the
RelayMiner can sign without the Mac. Operator `pokt1kq7d6j7g3gq98rwsxlx9llwhnmy4qqedrqhej0`, funded from the owner.
The Mac operator `pokt1mj9574ugmp9ujm5qre8h7fyclmaequ0jxttfw5` is unused.

| Step | Tx hash | Height | Result |
|---|---|---|---|
| Operator public key on-chain (1 uPOKT self-transfer from the server operator) | `A8095AA2C5C7FE5D12DA2E71089C512864908E64C16C5B0F49293BD1975FA8F5` | 722731 | code 0 |
| Stake test application `dsa-app` for `dietary-supplement-analysis`, 1,100 POKT ([config](beta-stake/app_stake_config.yaml)) | `6734D5F40BE1E94F5A3434E0EE8A677F00CA52A24863BA22873F1956678005EE` | 722744 | code 0 |
| Stake supplier, 60,000 POKT, `rpc_type: REST`, `https://pokt-beta.trackmysupplement.com`, 100% rev share to owner ([config](beta-stake/supplier_stake_config.yaml)). Signed by the operator: Beta rejects a first stake with services signed by the owner. | `9CBCBAAF6BCF9DA0A32CBCF818D3D2B410539DFA3DAC4FC97B78E914FAB351FA` | 722747 | code 0; service active from session starting 722761 |
| Relay test: `pocket-ap` v0.1.2 `call` from the Mac, `POST /v1/stack/analyze` ([config](beta-stake/pocket-ap.yaml)) | (off-chain) | session 722761–722780 | 200 with correct analysis in 1.7 s; session `fd050138…e9b9`, 1 endpoint supports REST |
| Claim created by the HA miner (1 relay, 500 CU, 20 uPOKT) | `F3D81B3F797F86830CE1ACDBFBEA473EE989D4816093179A082BB423D9C788EB` | 722793 | code 0; proof not required |
| Claim settled (`EventClaimSettled`, end block) | (end-block event) | 722813 | 20 uPOKT settled; 15 uPOKT to the owner, 4 uPOKT to `pokt10d07y265gmmuvt4z0w9aw880jnsr700j8yv32t`, 1 uPOKT deflation |

### Running stack (server)

| Container | Image | Role |
|---|---|---|
| `dietary-supplement-analysis-backend` | built from this repo at `main` | Backend on the private `pocket-supplier` network, port 8080 |
| `pocket-beta-redis` | `redis:8.10.1-alpine` | `noeviction`, appendonly |
| `pocket-beta-miner`, `pocket-beta-relayer` | `ghcr.io/pokt-network/pocket-relay-miner:v0.1.0` | HA RelayMiner, chain `pocket-lego-testnet` |
| `pocket-caddy` | `caddy:2` | TLS: `pokt-beta.` → relayer, `agents.` → backend |

Two differences from the skill's HA templates for relay-miner v0.1.0: the relayer config rejects
`pocket_node.chain_id`, and miner `logging` accepts `format` but not `output`. Both are fixed in `provision-beta.sh`.
