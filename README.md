# Dietary Supplement Label and Nutrient Intake Analysis

A Pocket Network service (`dietary-supplement-analysis`) for AI agents. Give it a list of supplements and it returns per-nutrient daily totals across the whole stack, compared with NIH reference intakes (RDA/AI) and upper limits (UL). Every number traces back to its label and source.

- **Label data:** [NIH Dietary Supplement Label Database (DSLD)](https://dsld.od.nih.gov/) API v9
- **Reference values:** Food and Nutrition Board DRIs, as published on the [NIH Office of Dietary Supplements fact sheets](https://ods.od.nih.gov/factsheets/list-all/)
- **Running a supplier or gateway:** see [OPERATORS.md](OPERATORS.md).
- **What it is not:** medical advice, an efficacy database or an interaction checker. It reports what labels declare and how the totals compare with published reference values. For medications, see the Pocket services `med-safety` and `fda`.

> **Status:** `v0.1.0`. Phases 1–3 of [PLAN.md](PLAN.md) are done and tested against the live NIH DSLD API. Pocket's own backend linter (`lint_backend.py`) passes, and the service card ([card/card.json](card/card.json)) passes the schema check. Phase 4 is done: the service is registered and staked on Beta TestNet at `https://pokt-beta.trackmysupplement.com`, and a paid relay has been claimed and settled on-chain (see [deploy/PHASE4_READINESS.md](deploy/PHASE4_READINESS.md)). A direct demo endpoint for judges is at `https://agents.trackmysupplement.com`. Full judge instructions come in Phase 6.

### Try it (real DSLD labels)

```bash
curl -s http://localhost:8080/v1/stack/analyze -H 'Content-Type: application/json' -d '{
  "age": 34, "sex": "female",
  "products": [
    {"dsld_id": 230932},
    {"dsld_id": 338022},
    {"dsld_id": 332278},
    {"name": "Custom magnesium", "ingredients": [{"name": "magnesium", "amount": 250, "unit": "mg"}]}
  ]}'
```

The stack is a vitamin D3 5000 IU softgel, a women's multivitamin, Natrol Magnesium Night (which contains a proprietary sleep blend) and 250 mg of magnesium. Two flags come back:
- Vitamin D `above_ul`: 150 mcg against a 100 mcg UL.
- Magnesium `above_ul`: 575 mg against the 350 mg UL for supplements.

Folate counts only the 480 mcg of folic acid toward its UL, the blend's unquantified melatonin is reported as a data gap, and every number links to its DSLD label.

## Endpoints

All inputs come from the JSON request body. All responses are JSON objects, errors included.

| Method | Path | Purpose |
|---|---|---|
| GET/HEAD | `/` | Service identity |
| GET | `/v1/version` | `{"service":"dietary-supplement-analysis","version":"0.1.0"}` |
| GET | `/v1/health` | `{"status":"ok"}` |
| GET | `/openapi.json` | OpenAPI 3.1 spec (also at [openapi/openapi.json](openapi/openapi.json)) |
| POST | `/v1/products/search` | Find products in DSLD: `{"query":"vitamin d3 5000","brand":"NOW","limit":5}` |
| POST | `/v1/products/get` | Normalized labels: `{"dsld_id":12345}` or `{"dsld_ids":[...]}` (max 10) |
| POST | `/v1/nutrients/reference` | RDA/EAR/AI/UL for one nutrient: `{"nutrient":"vitamin d","age":34,"sex":"female"}` (offline) |
| POST | `/v1/stack/analyze` | Per-nutrient totals across 1–15 products |
| POST | `/v1/tool` | MCP-style dispatcher: `{"tool":"stack_analyze","arguments":{...}}` |

### `POST /v1/stack/analyze`

```json
{
  "age": 34,
  "sex": "female",
  "products": [
    { "dsld_id": 12345, "servings_per_day": 1 },
    { "dsld_id": 67890 },
    { "name": "Homemade magnesium", "ingredients": [ { "name": "magnesium glycinate", "amount": 200, "unit": "mg", "nutrient_basis": "elemental" } ] }
  ]
}
```

- Each product is either a DSLD ID or a custom product with explicit ingredients. Custom ingredients may give a `form` (for example `"folic acid"` or `"d-alpha tocopherol"`) so IU and DFE conversions can be applied.
- `servings_per_day` defaults to the label's maximum daily servings, or 1 if the label doesn't say. Every default is listed in `assumptions`.
- `age` and `sex` are optional. Without them you get totals and overlaps, but no reference comparisons.
- Pregnancy and lactation aren't supported in v1. Sending them returns `422 UNSUPPORTED`.

The response contains `summary`, `assumptions`, `nutrient_totals`, `overlaps`, `unrecognized_ingredients`, `data_gaps`, `products`, `sources` and `disclaimer`. Each nutrient total includes:

| Field | Meaning |
|---|---|
| `daily_total` | Sum across products, in the nutrient's canonical unit (mcg RAE, mcg DFE, mg, mcg) |
| `complete` | `false` when some label rows couldn't be counted (see `data_gaps`); the total is then a lower bound |
| `reference` | RDA, EAR, AI and UL for the profile, with `ul_scope` and `ul_note` |
| `amount_toward_ul` | The part the UL applies to: folic acid only for folate, preformed vitamin A only for vitamin A |
| `percent_of_ul`, `percent_of_rda`, `percent_of_ai` | Percent of each reference value. `percent_of_ul` is withheld when the UL portion is only partly known and the UL isn't already exceeded |
| `flags` | `above_ul`, `below_reference`. No flag means nothing to report, not a judgement about the stack |
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

- Up to 15 products per analyze call, 10 IDs per get call, and 10 search results.
- DSLD calls run at most 4 at a time, with a 6 s deadline each and an 8 s budget per request. Labels are cached for 7 days and searches for 24 hours; a stale copy is served if DSLD is down. Measured against live DSLD: a cold 15-product analyze takes 1.5 s and a warm one 17 ms.
- Text that Pocket gateways treat as an error signal ("timeout", "block not found" and others) is `\u`-escaped in responses. It decodes to the same string.
- Ages from 1 to 120. Infant, pregnancy and lactation values aren't included in v1.

## Disclaimer and licenses

Label and reference data only. Not medical advice. Totals exclude food and medications. DSLD and ODS content are U.S. Government works from the National Institutes of Health. No license has been chosen for the code yet.
