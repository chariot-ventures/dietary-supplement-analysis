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
- [ ] Make the GitHub repo public (owner, in GitHub settings). The card's spec, docs and operator
      links point at `main` and the `v0.1.0` tag and must be readable without a login.
- [ ] Owner checks the DRI values in `data/source/manual.json` against the NIH ODS fact sheets.
- [ ] VPS (Ubuntu 24.04, 2 vCPU, 4 GB RAM, 25+ GB SSD) and DNS for `beta-supplement.<domain>` and `api-supplement.<domain>`.
- [ ] Owner, operator and application keys created on the developer's machine (macOS: `pocketd`
      command-line workflow); funded from the faucet.

## Order (skill workflow steps 6-9)

1. `pocketd tx service add-service dietary-supplement-analysis "Dietary Supplement Label and Nutrient Intake Analysis" 500 --card-file ./card/card.json --from <owner> --network=beta ...`, then read the card back with `encode_card.py diff`.
2. `render_templates.py answers.json --out ./deploy` for stake configs, HA RelayMiner, Caddy, SAGE and pocket-ap files.
3. Stake the supplier (`rpc_type: REST`), start the RelayMiner, put Caddy in front, stake the test application.
4. Wait for the session boundary, relay with `pocket-ap call`, then `query_state.py --claims` until a claim settles.
