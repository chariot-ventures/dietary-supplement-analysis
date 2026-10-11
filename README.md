# Dietary Supplement Label and Nutrient Intake Analysis

A Pocket Network service (`dietary-supplement-analysis`) for AI agents. Give it a list of supplements and it returns per-nutrient daily totals across the whole stack, compared with NIH reference intakes (RDA/AI) and upper limits (UL). Every number traces back to its label and source.

- **Label data:** [NIH Dietary Supplement Label Database (DSLD)](https://dsld.od.nih.gov/) API v9
- **Reference values:** Food and Nutrition Board DRIs, as published on the [NIH Office of Dietary Supplements fact sheets](https://ods.od.nih.gov/factsheets/list-all/)
- **Running a supplier or gateway:** see [OPERATORS.md](OPERATORS.md).
- **What it is not:** medical advice, an efficacy database or an interaction checker. It reports what labels declare and how the totals compare with published reference values. For medications, see the Pocket services `med-safety` and `fda`.

> **Status:** `v0.2.0` (see [CHANGELOG.md](CHANGELOG.md)). Phases 1–3 of [PLAN.md](PLAN.md) are done and tested against the live NIH DSLD API. Pocket's own backend linter (`lint_backend.py`) passes, and the service card ([card/card.json](card/card.json)) passes the schema check. Phase 4 is done: the service is registered and staked on Beta TestNet at `https://pokt-beta.trackmysupplement.com`, and a paid relay has been claimed and settled on-chain (see [deploy/PHASE4_READINESS.md](deploy/PHASE4_READINESS.md)). To try it, see [For judges](#for-judges-try-it-in-one-minute).

## For judges: try it in one minute

| | |
|---|---|
| Service ID | `dietary-supplement-analysis` (Pocket Network Beta TestNet, `rpc_type: REST`, 500 compute units per relay) |
| Relay endpoint (staked supplier) | `https://pokt-beta.trackmysupplement.com`. Accepts signed Pocket relays only. |
| Demo endpoint (direct, free) | `https://agents.trackmysupplement.com`. The same backend without the relay layer, so you can use `curl`. Limited to 30 requests per minute per client; over the limit it returns `429` with `"code":"RATE_LIMITED"` and a `Retry-After` header. |

**1. Reference intakes for one nutrient** (offline data, instant):

```bash
curl -s https://agents.trackmysupplement.com/v1/nutrients/reference \
  -H 'Content-Type: application/json' -d '{"nutrient":"vitamin d","age":34,"sex":"female"}'
```

Returns RDA 15 mcg, EAR 10 mcg and UL 100 mcg, with the NIH fact sheet link.

**2. Search real labels in the NIH Dietary Supplement Label Database:**

```bash
curl -s https://agents.trackmysupplement.com/v1/products/search \
  -H 'Content-Type: application/json' -d '{"query":"vitamin d3 5000","limit":3}'
```

**3. Analyze a whole supplement stack in one call**, naming products the way a user would (no IDs needed), and ask what adding one more would do:

```bash
curl -s https://agents.trackmysupplement.com/v1/stack/analyze -H 'Content-Type: application/json' -d '{
  "age": 62, "sex": "female",
  "products": [
    {"query": "Centrum Silver Women 50+"},
    {"query": "Nature Made Ultra Fish Oil 1400"},
    {"query": "KAL Magnesium Glycinate 400"},
    {"query": "Thompson Zinc 50 mg", "servings_per_day": 1}
  ],
  "candidates": [{"query": "vitamin d3 5000 iu"}]}'
```

Read `agent_summary` first: plain sentences an agent can relay as written. Then:
- `resolutions`: which NIH label each name was matched to, with `confidence` (high/medium/low) and alternatives.
- `nutrient_totals`: per nutrient, the daily total, `flags` (`above_ul`, `near_ul`), `severity`, the percent of the upper limit (UL), `reference.ul_basis` (what the UL protects against) and each product's contribution.
- `suggestions`: single-product changes that would bring an above-UL nutrient back under its UL, with the resulting amount.
- `candidate_results`: what adding each candidate would change.
- `data_gaps`: anything that couldn't be counted, and `DATA_SUSPECT` entries where NIH's label record looks wrong.

The classic version with DSLD IDs still works. This stack (a vitamin D3 5000 IU softgel, a women's multivitamin, Natrol Magnesium Night and 250 mg of magnesium) comes back with vitamin D at 150 mcg against a 100 mcg UL and magnesium at 575 mg against the 350 mg UL for supplements:

```bash
curl -s https://agents.trackmysupplement.com/v1/stack/analyze -H 'Content-Type: application/json' -d '{
  "age": 34, "sex": "female",
  "products": [{"dsld_id": 230932}, {"dsld_id": 338022}, {"dsld_id": 332278},
    {"name": "Custom magnesium", "ingredients": [{"name": "magnesium", "amount": 250, "unit": "mg"}]}]}'
```

**4. Look up a bottle by its barcode:**

```bash
curl -s https://agents.trackmysupplement.com/v1/products/lookup -H 'Content-Type: application/json' -d '{"upc":"031604026974"}'
```

**5. For agent frameworks:** `GET /v1/tools` returns every operation as a tool definition with a JSON Schema input, and `GET /v1/guide` returns a usage guide (also in [llms.txt](llms.txt)).

### Through Pocket Network (paid relay)

You need an application staked for `dietary-supplement-analysis` on Beta TestNet. Fund an address from the [Beta faucet](https://faucet.beta.pocket.network/) and stake it as an application with at least 1,000 POKT. Then install [pocket-ap](https://github.com/pokt-network/pocket-ap) and relay with this repo's [client config](deploy/beta-stake/pocket-ap.yaml):

```bash
export POCKET_APP_PRIVATE_KEY=<your app key, 64 hex>   # pocketd keys export <name> --unarmored-hex --unsafe
pocket-ap call --config deploy/beta-stake/pocket-ap.yaml \
  --service dietary-supplement-analysis --rpc-type rest \
  -X POST --path /v1/stack/analyze \
  -d '{"age":34,"sex":"female","products":[{"name":"Custom magnesium","ingredients":[{"name":"magnesium","amount":250,"unit":"mg"}]}]}' -v
```

### On-chain record (Beta TestNet)

| Step | Tx hash | Block |
|---|---|---|
| Service registered, with the card from [card/card.json](card/card.json) | [`BC01B11F…7DD5`](https://sauron-api.beta.infra.pocket.network/cosmos/tx/v1beta1/txs/BC01B11FFF4100473B84D483026F266111CF73CE9B07584E3083EDCF19B47DD5) | 722359 |
| Supplier staked, 60,000 POKT | [`9CBCBAAF…51FA`](https://sauron-api.beta.infra.pocket.network/cosmos/tx/v1beta1/txs/9CBCBAAF6BCF9DA0A32CBCF818D3D2B410539DFA3DAC4FC97B78E914FAB351FA) | 722747 |
| Test application staked, 1,100 POKT | [`6734D5F4…05EE`](https://sauron-api.beta.infra.pocket.network/cosmos/tx/v1beta1/txs/6734D5F40BE1E94F5A3434E0EE8A677F00CA52A24863BA22873F1956678005EE) | 722744 |
| Claim for the first paid relay (settled at block 722813) | [`F3D81B3F…88EB`](https://sauron-api.beta.infra.pocket.network/cosmos/tx/v1beta1/txs/F3D81B3F797F86830CE1ACDBFBEA473EE989D4816093179A082BB423D9C788EB) | 722793 |

Details and the server setup are in [deploy/PHASE4_READINESS.md](deploy/PHASE4_READINESS.md).

## Endpoints

All inputs come from the JSON request body. All responses are JSON objects, errors included.

| Method | Path | Purpose |
|---|---|---|
| GET/HEAD | `/` | Service identity |
| GET | `/v1/version` | `{"service":"dietary-supplement-analysis","version":"0.2.0"}` |
| GET | `/v1/health` | `{"status":"ok"}` |
| GET | `/openapi.json` | OpenAPI 3.1 spec (also at [openapi/openapi.json](openapi/openapi.json)) |
| GET | `/v1/tools` | Tool definitions (`name`, `description`, JSON Schema `input_schema`) for function calling |
| GET | `/v1/guide` | Usage guide for agents, as markdown inside JSON (same text as [llms.txt](llms.txt)) |
| POST | `/v1/stack/analyze` | One call: per-nutrient totals across 1–15 products (names, barcodes, IDs or custom), flags, fixes, what-if candidates |
| POST | `/v1/products/search` | Find products in DSLD: `{"query":"vitamin d3 5000","brand":"NOW","limit":5}`; label versions collapsed |
| POST | `/v1/products/lookup` | Label for a barcode: `{"upc":"031604026974"}` |
| POST | `/v1/products/get` | Normalized labels: `{"dsld_id":12345}` or `{"dsld_ids":[...]}` (max 10) |
| POST | `/v1/nutrients/reference` | RDA/EAR/AI/UL and UL basis for one nutrient: `{"nutrient":"vitamin d","age":34,"sex":"female"}` (offline) |
| POST | `/v1/tool` | MCP-style dispatcher: `{"tool":"stack_analyze","arguments":{...}}` |

### `POST /v1/stack/analyze`

```json
{
  "age": 34,
  "sex": "female",
  "products": [
    { "query": "Centrum Silver Women 50+" },
    { "upc": "031604026974", "servings_per_day": 1 },
    { "dsld_id": 67890 },
    { "name": "Homemade magnesium", "ingredients": [ { "name": "magnesium glycinate", "amount": 200, "unit": "mg", "nutrient_basis": "elemental" } ] }
  ],
  "candidates": [ { "query": "vitamin d3 5000 iu" } ]
}
```

- **Products** (1–15) can be a product name (`query`, optionally with `brand`), a barcode (`upc`), a DSLD ID, or a custom product with explicit ingredients. Custom ingredients may give a `form` (for example `"folic acid"` or `"d-alpha tocopherol"`) so IU and DFE conversions can be applied.
- **Names and barcodes** are resolved server-side. A name is matched against DSLD search results by the share of its words found in the brand and product name; label versions of the same product are collapsed and the newest on-market one is used. `resolutions[]` records each match with `confidence` (`high`: every word matched one product; `medium`: every word matched but other products did too, or most words matched; `low`: under 60%) and up to three alternatives. A product that can't be identified is reported (`PRODUCT_NOT_RESOLVED`) and left out; the call fails with 404 only when nothing could be identified.
- **Candidates** (up to 5) are products the user is considering. Each is evaluated as an addition to the stack in `candidate_results[]` and isn't counted in the totals.
- `servings_per_day` defaults to the label's maximum daily servings, or 1 if the label doesn't say. Every default is listed in `assumptions`.
- `age` and `sex` are optional. Without them you get totals and overlaps, but no reference comparisons.
- Pregnancy and lactation aren't supported yet. Sending them returns `422 UNSUPPORTED`.

The response contains, in this order: `profile`, `summary`, `agent_summary`, `resolutions` (when names or barcodes were given), `assumptions`, `suggestions`, `candidate_results` (when candidates were given), `nutrient_totals`, `overlaps`, `unrecognized_ingredients`, `data_gaps`, `products`, `sources` and `disclaimer`.

- **`agent_summary`** is two to five plain sentences, generated deterministically from the numbers below, that an agent can relay as written.
- **`suggestions`** lists, for each above-UL nutrient, up to three single-product changes (`reduce_servings` or `remove_product`) with the resulting amount, whether that alone brings the nutrient to or under the UL (`resolves`), which other above-UL nutrients it also fixes, and which other nutrients a removal would lower. They're arithmetic, not advice.
- **`candidate_results`** gives each candidate a `verdict` (`adds_above_ul`, `increases_above_ul`, `adds_near_ul` or `no_new_flags`), the new flags and the before and after totals.

Each nutrient total includes:

| Field | Meaning |
|---|---|
| `daily_total` | Sum across products, in the nutrient's canonical unit (mcg RAE, mcg DFE, mg, mcg) |
| `complete` | `false` when some label rows couldn't be counted (see `data_gaps`); the total is then a lower bound |
| `reference` | RDA, EAR, AI and UL for the profile, with `ul_scope`, `ul_note` and `ul_basis` (what the UL protects against, for example "Reduced copper status" for zinc) |
| `amount_toward_ul` | The part the UL applies to: folic acid only for folate, preformed vitamin A only for vitamin A |
| `percent_of_ul`, `percent_of_rda`, `percent_of_ai` | Percent of each reference value. `percent_of_ul` is withheld when the UL portion is only partly known and the UL isn't already exceeded |
| `coverage` | Percent of the RDA (or AI) these supplements alone supply. Informational: diet normally supplies much of it, so low coverage isn't a shortfall |
| `flags` | `above_ul` (over the UL) or `near_ul` (90–100% of the UL). No flag means nothing to report, not a judgement about the stack |
| `severity` | `high` (twice the UL or more), `moderate` (above the UL), `low` (near the UL), or `null` |
| `contributions` | Each product's label amount, converted amount, servings per day and daily amount |

### Errors

```json
{ "error": { "code": "INVALID_INPUT", "message": "products: ...", "retryable": false, "field": "products" } }
```

| Code | Status | When |
|---|---|---|
| `INVALID_INPUT` | 400 | Malformed or out-of-range input |
| `NOT_FOUND` | 404 | Unknown DSLD ID, nutrient or route |
| `UNSUPPORTED` | 422 | Pregnancy or lactation, or age under 1 |
| `UPSTREAM_UNAVAILABLE` | 424 | DSLD can't be reached and nothing is cached (`retryable: true`) |
| `INTERNAL_ERROR` | 422 | Unexpected failure. Returned as 4xx because Pocket gateways treat 5xx as a supplier fault |

### Data gap codes

| Code | Meaning |
|---|---|
| `BLEND_UNQUANTIFIED` | A proprietary blend lists ingredients without their own amounts; the blend weight is not divided among them |
| `QUANTITY_MISSING` | A recognized nutrient row has no amount |
| `UNIT_NOT_CONVERTIBLE` | The unit can't be converted unambiguously, for example vitamin A in IU with an unknown form |
| `COMPOUND_WEIGHT` | The amount may be compound weight, not elemental mineral |
| `AMBIGUOUS_BASIS` | A custom ingredient named for a compound lacks `nutrient_basis` |
| `UL_PARTIAL` | The UL applies to one form only (folic acid, preformed vitamin A) and some forms are unspecified |
| `PROFILE_MISSING` | No age and sex, so no reference comparison |
| `PRODUCT_NOT_RESOLVED` | A product name or barcode couldn't be matched to a DSLD label; it isn't counted |
| `DATA_SUSPECT` | NIH's label record looks inconsistent; the amount is still counted. `check` says which test failed: `duplicate_row` (the same ingredient twice under one heading, like EPA entered as DHA), `nested_exceeds_parent` (rows add up to more than their declared total), `percent_dv_mismatch` (the printed %DV contradicts the amount under both the current and the pre-2016 Daily Value), `implausible_amount` (over 50 times the highest adult UL, typically mg typed for mcg) |
| `INTERACTIONS_NOT_ASSESSED` | Always present: drug and supplement interactions are out of scope |

## How the numbers are produced

- **DSLD label details** that current labels need:
  - DSLD often stores vitamin A as plain mcg or mg. It's read as mcg RAE only when the label's %DV matches the 900 mcg RAE Daily Value.
  - When DSLD leaves out a unit (for example "6 NP"), it's inferred only if the label's %DV matches the FDA Daily Value; otherwise it's a gap.
  - Rows nested under a nutrient break it down by form (folate 800 mcg DFE = folic acid 480 mcg). They give the exact UL portion and are never counted twice.
  - Stated form shares ("40% as beta-carotene") split IU conversions exactly when they cover 100%. When they cover less, the rest is treated as an unknown form.
  - Gamma and delta tocopherols and tocotrienols are not counted as vitamin E.
- **Matching** an ingredient to a nutrient tries, in order: the DSLD `ingredientGroup`, the UNII code, an exact synonym, then an exact form name that belongs to exactly one nutrient. There's no substring or fuzzy matching, so "Vitamin B" never matches "Vitamin B12". Anything else goes to `unrecognized_ingredients`.
- **Unit conversion** happens only when the result is unambiguous:
  - Vitamin D: 1 mcg = 40 IU.
  - Vitamin E: natural form 0.67 mg per IU, synthetic form 0.45 mg per IU. An unknown form becomes a data gap.
  - Vitamin A: IU converts only for retinol (0.3 mcg RAE per IU) or supplemental beta-carotene (0.3 mcg RAE per IU).
  - Folate: plain mcg of folic acid × 1.7 = mcg DFE.
  - Percent DV is shown exactly as on the label and is never used in totals.
- **UL scope** is stored for each nutrient and explained in the response:
  - Magnesium: supplements and medications only.
  - Folate: folic acid only.
  - Vitamin A: preformed only.
  - Niacin and vitamin E: supplemental intake.
  - Everything else is a total-intake UL. A supplement total under one of those doesn't show that total intake is under it, and `assumptions` says so.
- **Reference data** lives in [data/source/manual.json](data/source/manual.json). [scripts/build-nutrients.ts](scripts/build-nutrients.ts) builds [data/nutrients.json](data/nutrients.json) from it, and from the SuppleTracker `global_compounds` export if one is present. The build validates units, sources, age ranges and synonym collisions. It covers 26 vitamins and minerals with DRIs, plus EPA, DHA, melatonin, CoQ10 and beta-carotene, which are recognized but have no reference values.

## Running locally

```bash
npm ci
npm run dev                   # http://localhost:8080 (live DSLD)
DSLD_FIXTURES_DIR=test/fixtures/dsld npm run dev   # offline, synthetic fixture labels 900001-900005
npm run check                 # data + OpenAPI freshness, lint, typecheck, tests
docker compose up --build     # container on 127.0.0.1:8080
```

| Env var | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listen address |
| `DSLD_API_KEY` | none | Sent to DSLD as `X-Api-Key` if set |
| `DSLD_BASE_URL` | `https://api.ods.od.nih.gov/dsld/v9` | DSLD API base |
| `DSLD_PREWARM_IDS` | none | Comma-separated label IDs to cache at startup |
| `DSLD_FIXTURES_DIR` | none | Serve DSLD from local `label-<id>.json` files (dev only; `test/fixtures/dsld/real` holds 12 real labels) |
| `UPSTREAM_BUDGET_MS` | `8000` | Total time one request may spend waiting on DSLD before answering `424` |
| `LOG_LEVEL` | `info` | Logs record method, path, status and duration only, never request bodies |

## Limits

- Up to 15 products and 5 candidates per analyze call, 10 IDs per get call, and 10 search results.
- DSLD calls run at most 4 at a time, with a 6 s deadline each and an 8 s budget per request. Labels are cached for 7 days and searches for 24 hours; a stale copy is served if DSLD is down. Measured against live DSLD: a cold 15-product analyze takes 1.5 s and a warm one 17 ms.
- Text that Pocket gateways treat as an error signal ("timeout", "block not found" and others) is `\u`-escaped in responses. It decodes to the same string.
- Ages from 1 to 120. Infant, pregnancy and lactation values aren't included in v1.
- The public demo endpoint allows 30 requests per minute per client and 600 per minute overall. Relays through Pocket Network aren't limited this way.

## Disclaimer and licenses

Label and reference data only. Not medical advice. Totals exclude food and medications. DSLD and ODS content are U.S. Government works from the National Institutes of Health. No license has been chosen for the code yet.
