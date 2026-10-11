# Dietary Supplement Analysis — implementation plan

A Pocket Network service that gives AI agents structured supplement-label data and per-nutrient stack analysis, built from the NIH Dietary Supplement Label Database (DSLD) and NIH dietary reference values. Built for the Pocket Network Agentic Services Hackathon.

- **Deadline:** submissions due by midnight EST on **Monday, October 12, 2026**. Treat that as 11:59 PM ET Monday and aim to submit by Monday evening.
- **Target:** deployed and serving on **Beta TestNet**, with a settled claim, a public repo, and test instructions for judges.
- **Later (not this weekend):** MainNet, Service Audit pass, Agentic Portal listing.

---

## 0. How to use this plan with Claude Code

1. Create an empty GitHub repo (suggested name: `dietary-supplement-analysis`, matching the Pocket service ID) and put this file in it as `PLAN.md`.
2. In Claude Code, add Pocket's read-only MCP server (catalogue search, service ID checks, card validation, Service Audit):
   ```bash
   claude mcp add --transport http pocket https://mcp.pocketmcp.network/mcp
   ```
3. Add Pocket's **Service Builder skill** to Claude Code:
   https://github.com/pokt-network/pocket-network-resources/blob/main/service-builder/pocket-service-builder.skill
   It checks ID collisions, fetches live fees and prices, lints the backend against gateway rules, writes and validates the card, and renders the stake, RelayMiner, Caddy and gateway files. Use it for Phase 4 instead of writing those files by hand.
4. Tell Claude Code: *"Read PLAN.md. Build Phases 1–3 first, then stop and confirm with me before spending any testnet tokens in Phase 4."*

Pocket docs this plan is based on (re-read if anything disagrees):
- Services overview: https://docs.pocket.network/services/
- Register (ID, price, card): https://docs.pocket.network/services/register/
- Deploy (backend rules, HA RelayMiner, testing): https://docs.pocket.network/services/deploy/
- Supplier servers (sizing, pinned versions, known failures): https://docs.pocket.network/services/servers/
- Listing criteria and audit rules: https://docs.pocket.network/agent-services/list-your-service/
- Networks (Beta TestNet endpoints, faucet): https://docs.pocket.network/get-started/networks/

---

## 1. What the service does

**One-line pitch:** Give an agent a list of supplements; get back exact per-nutrient daily totals across the whole stack, compared with NIH reference intakes and upper limits, with every number traced to its label and source.

**Why it's new on Pocket:** As of October 10, 2026, none of the 113 portal services or 265 on-chain service IDs covers supplements, nutrition, vitamins, NIH DSLD data or intake limits. The nearest services are drug-only: `fda` (drug labels and FAERS), `med-safety` (drug label highlights, shortages, recalls), `pmic-pharma-signals` and `clinical-trials`. Position this service as the supplement-side complement to those, not a competitor.

**Who calls it:** wellness and health-coaching agents, research assistants, pharmacy and nutrition apps, and any agent asked "is my supplement stack too much of anything?"

**What it is not:** a medical advice engine, an efficacy database or a drug–supplement interaction checker. It reports what labels declare and how the totals compare with published reference values. It never says a stack is "safe."

---

## 2. What to reuse from SuppleTracker (and what not to)

SuppleTracker (`micallb/suppletracker-final`, Next.js 12 + Supabase) already solved the domain problems. The new service should port the **logic and data**, not the app.

### Reuse

| From SuppleTracker | What it gives us | How to use it |
|---|---|---|
| `pages/api/dsld-search.js`, `getSuppFromDsldUsingId.js` | Working DSLD v9 calls (`/search-filter`, `/label/{id}`) and the on-market filter | Port the pattern to a typed DSLD client. Fix: URL-encode the query, use `status=1` instead of filtering client-side, cap results, add concurrency limits and caching. |
| `pages/api/addGlobalDSLDSupplement.js` | How label `ingredientRows` → `{name, quantity, unit}` | Port, but handle every serving-size quantity, `nestedRows` (blends) and missing quantities instead of reading only `quantity[0]`. |
| `lib/components/CompTable.js` (≈ lines 180–290) | DRI lookup: RDA > EAR > AI priority, age-range matching by sex, UL comparison | Port as a pure, unit-tested function. Return **all** available reference types, not just the top one. |
| Supabase table `global_compounds` (`name`, `akas`, `ods_factsheets`, `dri_data`) | Nutrient synonym lists, NIH fact-sheet links, and DRI tables by type → sex → age range | **Export it to `data/nutrients.json`** (see 2a). This is the most valuable asset. |
| Supabase table `global_dsld_supplements` (`dsld_id`, `page_data`) | Cached full DSLD labels for products your users added | Optional: export as a warm cache / test fixtures. |

### 2a. Export `global_compounds` (owner does this, ~10 minutes)

In the Supabase SQL editor for the SuppleTracker project:

```sql
select id, name, akas, ods_factsheets, dri_data
from global_compounds
order by name;
```

Download as JSON → commit as `data/source/global_compounds.export.json`. A build script converts it to `data/nutrients.json` (schema in §5).

The `dri_data` shape used by the app is:

```json
{
  "unit": "mcg",
  "type": {
    "rda": { "male": { "years": [ { "lower": 19, "upper": 50, "amount": 15 } ] }, "female": { "years": [ ... ] } },
    "ear": { ... }, "ai": { ... }, "ul": { ... }
  }
}
```

`lower: null` means "up to `upper`"; `upper: null` means "`lower` and older."

**If the export isn't available** (or a nutrient is missing from it), Claude Code builds the entry from the NIH ODS health-professional fact sheet for that nutrient (https://ods.od.nih.gov/factsheets/list-all/), storing the fact-sheet URL with each value. Every value in `nutrients.json` must carry a `source_url`.

### Do not reuse

Next.js, React, Chakra, the Supabase client or anon key, auth, diaries, user tables, Paddle, ads, email, `server.js` (it expects local cert files). None of it belongs in an agent-facing backend, and none of the user data should go near a public relay.

### Known issues in the app that the service must not inherit

- `getSuppsWithCompound.js` interpolates the search term into the URL without encoding.
- `dsld-search.js` fetches up to 50 full labels per search with unbounded `Promise.all` — too slow for a relay and risks DSLD rate limits.
- Compound matching uses substring `includes` both ways (e.g., "Vitamin B" matches "Vitamin B12"). Use DSLD's `ingredientGroup`, `uniiCode` and exact synonym matching instead.
- DRI comparison only happens when units already match; IU and DFE/RAE units silently skip. The service must convert where it's unambiguous and report a data gap where it isn't.
- Client errors return 500. Pocket gateways treat 5xx as supplier failures.

---

## 3. Service identity

| Field | Value |
|---|---|
| Service ID | `dietary-supplement-analysis` (1–42 chars, `a-z0-9-_`, **permanent**). Check it's free on Beta TestNet with the Pocket MCP server or `pocketd query service show-service dietary-supplement-analysis --network=beta` before registering. Fallback: `supplement-label-analysis`. |
| Display name | `Dietary Supplement Label and Nutrient Intake Analysis` (letters, digits, `-`, `_` and spaces only, so no commas or slashes) |
| `apis[]` | `["dietary-supplement-analysis-api"]` |

**Why this name:** Pocket's docs recommend IDs named for the capability, and existing services follow that (`med-safety`, `clinical-trials`, `literature-search`). "Dietary supplement" is NIH's own term and what an agent would search for; "stack" is slang, so it stays only in the endpoint path (`/v1/stack/analyze`). The repo name matches the ID. How the portal ranks search results isn't documented, so also put these plain words in the display name and the first sentence of the card description (§8).
| `rpc_types` | `REST` |
| `results` | `variable` (live DSLD data can change between calls and suppliers) |
| `access` | `public` |
| Compute units per relay | Let the Service Builder skill fetch live parameters and suggest a price in line with comparable data services. Stay below the catalogue's 95th percentile (audit rule A9). |

---

## 4. API design

### Gateway rules every endpoint must follow

From Pocket's deploy and servers docs:

- Every response body is a JSON object starting with `{`, including errors. No HTML, no empty 200s.
- All inputs come from the JSON request body. Gateways drop caller headers (`Authorization`, `X-Api-Key`, cookies), so nothing may depend on them.
- Client errors: `400`/`422` with a JSON error body. **Never return 5xx** for bad input; gateways retry 5xx elsewhere, penalize the supplier and don't pay.
- Respond within about **10 seconds**; gateway relay timeout is 30 s.
- Don't use the words `timeout`, `bad gateway`, `service unavailable`, `gateway timeout`, `connection refused` or `connection reset` anywhere in the first 2 KB of a success body (gateways scan for them). No field named `timeout`.
- No gzip. Return identity-encoded bytes.
- Answer `GET /` and `HEAD /` with 2xx JSON.
- Accept chunked request bodies with no `Content-Length`.
- Listen on port **8080**.
- Put short metadata fields first and large arrays last in every response.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET/HEAD | `/` | `{"service":"dietary-supplement-analysis","status":"ok","docs":"<README url>"}` |
| GET | `/v1/version` | Identity probe: `{"service":"dietary-supplement-analysis","version":"0.1.0"}` |
| GET | `/v1/health` | Readiness: `{"status":"ok"}` |
| GET | `/openapi.json` | OpenAPI 3.1 spec (also committed in the repo) |
| POST | `/v1/products/search` | Find products in DSLD |
| POST | `/v1/products/get` | Normalized label(s) by DSLD ID |
| POST | `/v1/nutrients/reference` | Reference intakes for one nutrient at an age and sex (offline, deterministic) |
| POST | `/v1/stack/analyze` | The main product: per-nutrient totals across a stack |
| POST | `/v1/tool` | Optional MCP-style route: `{"tool":"stack_analyze","arguments":{...}}` dispatching to the routes above. The portal's drug services expose a `/v1/tool` route like this; do it last if time allows. |

### Common response fields

```json
{
  "service": "dietary-supplement-analysis",
  "version": "0.1.0",
  "as_of": "2026-10-11",
  "...": "endpoint-specific fields",
  "sources": [ { "name": "NIH Dietary Supplement Label Database", "url": "https://dsld.od.nih.gov/label/12345", "retrieved": "2026-10-11" } ],
  "disclaimer": "Label and reference data only. Not medical advice. Totals exclude food and medications."
}
```

### Error body (4xx)

```json
{ "error": { "code": "INVALID_INPUT", "message": "products must be a non-empty array (max 15)", "retryable": false, "field": "products" } }
```

Codes: `INVALID_INPUT` (400), `NOT_FOUND` (404, e.g., unknown DSLD ID), `UNSUPPORTED` (422), `UPSTREAM_UNAVAILABLE` (424, `retryable: true`, when DSLD can't be reached and nothing is cached). Agents branch on `code`, so keep codes stable.

### `POST /v1/products/search`

Request:
```json
{ "query": "vitamin d3 5000", "brand": "NOW", "ingredient": "cholecalciferol", "on_market_only": true, "limit": 5 }
```
- `query` required unless `brand` or `ingredient` is given. `limit` 1–10, default 5.
- Use DSLD `search-filter` (`q`, `brand`, `ingredient_name`, `status=1` when on-market only, `size`), then fetch full labels for the top results with a concurrency limit of 4.

Response (`products` last):
```json
{ "service": "...", "version": "...", "as_of": "...", "query": { ... }, "total_hits": 412, "returned": 5,
  "products": [ { "dsld_id": 12345, "brand": "...", "name": "...", "upc": "...", "on_market": true,
                  "serving": { "quantity": 1, "unit": "Softgel", "daily_servings": { "min": 1, "max": 1 } },
                  "ingredient_count": 2, "source_url": "https://dsld.od.nih.gov/label/12345" } ],
  "sources": [ ... ], "disclaimer": "..." }
```

### `POST /v1/products/get`

Request: `{ "dsld_id": 12345 }` or `{ "dsld_ids": [12345, 67890] }` (max 10).

Response: one normalized label per ID:
```json
{ "dsld_id": 12345, "brand": "...", "name": "...", "upc": "...", "on_market": true,
  "serving": { "quantity": 1, "unit": "Softgel", "daily_servings": { "min": 1, "max": 1 } },
  "ingredients": [
    { "label_name": "Vitamin D3", "nutrient_id": "vitamin-d", "forms": ["Cholecalciferol"],
      "per_serving": { "amount": 125, "unit": "mcg" }, "label_amount": { "amount": 5000, "unit": "IU" },
      "percent_dv": 625, "in_blend": false }
  ],
  "statements": [ { "type": "Precautions", "text": "..." } ],
  "unrecognized_ingredients": [ ... ],
  "data_gaps": [ ... ],
  "source_url": "https://dsld.od.nih.gov/label/12345" }
```
Always keep the original label value next to any converted value.

### `POST /v1/nutrients/reference`

Request: `{ "nutrient": "vitamin d", "age": 34, "sex": "female" }`. `nutrient` accepts an ID or any synonym.

Response:
```json
{ "nutrient": { "id": "vitamin-d", "name": "Vitamin D", "unit": "mcg" },
  "profile": { "age": 34, "sex": "female" },
  "reference": { "rda": 15, "ear": 10, "ai": null, "ul": 100, "ul_scope": "total_intake" },
  "factsheet_url": "https://ods.od.nih.gov/factsheets/VitaminD-HealthProfessional/",
  "sources": [ ... ] }
```
This endpoint is fully offline and deterministic, which makes it the **functional health check** in the card.

### `POST /v1/stack/analyze` (the main product)

Request:
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
- 1–15 products. Each is either a DSLD ID or a custom product with explicit ingredients.
- `age` and `sex` are optional; without them, return totals and overlaps but no reference comparisons, plus a data gap saying so.
- `servings_per_day` default: the label's maximum daily servings, else 1. Record which default was used in `assumptions`. (Using the maximum is deliberately conservative for upper-limit checks.)
- Pregnancy and lactation aren't supported in v1. If passed, return `UNSUPPORTED` for that field rather than guessing.

Response (large arrays last):
```json
{
  "service": "dietary-supplement-analysis", "version": "0.1.0", "as_of": "2026-10-11",
  "profile": { "age": 34, "sex": "female" },
  "summary": { "products_matched": 3, "nutrients_totaled": 14, "above_ul": 1, "below_reference": 0, "data_gaps": 3 },
  "assumptions": [ "Product 67890: servings_per_day not given; used label maximum of 2" ],
  "nutrient_totals": [
    { "nutrient_id": "vitamin-d", "name": "Vitamin D",
      "daily_total": { "amount": 150, "unit": "mcg" },
      "reference": { "rda": 15, "ul": 100, "unit": "mcg", "ul_scope": "total_intake" },
      "percent_of_ul": 150, "percent_of_rda": 1000,
      "flags": ["above_ul"],
      "contributions": [
        { "product_ref": "dsld:12345", "label_amount": "5000 IU", "converted": { "amount": 125, "unit": "mcg" }, "servings_per_day": 1, "daily": { "amount": 125, "unit": "mcg" } },
        { "product_ref": "dsld:67890", "label_amount": "12.5 mcg", "servings_per_day": 2, "daily": { "amount": 25, "unit": "mcg" } }
      ] }
  ],
  "overlaps": [ { "nutrient_id": "vitamin-d", "product_refs": ["dsld:12345", "dsld:67890"] } ],
  "unrecognized_ingredients": [ { "product_ref": "dsld:67890", "label_name": "Ashwagandha root extract", "per_serving": { "amount": 300, "unit": "mg" } } ],
  "data_gaps": [
    { "code": "BLEND_UNQUANTIFIED", "product_ref": "dsld:67890", "detail": "Proprietary blend lists 6 ingredients without individual amounts" },
    { "code": "UNIT_NOT_CONVERTIBLE", "product_ref": "dsld:44444", "nutrient_id": "vitamin-a", "detail": "Label gives IU with unspecified form; cannot convert to mcg RAE" },
    { "code": "INTERACTIONS_NOT_ASSESSED", "detail": "Drug and supplement interactions are not evaluated. For medications, see Pocket service med-safety." }
  ],
  "products": [ { "product_ref": "dsld:12345", "brand": "...", "name": "...", "servings_per_day_used": 1, "source_url": "..." } ],
  "sources": [ ... ],
  "disclaimer": "..."
}
```

Flag rules:
- `above_ul` only when units are comparable and the UL's scope fits (see §6).
- `below_reference` when a total is under the RDA (or AI if no RDA). Use cautiously — supplements are only part of intake — and state that in `assumptions`.
- No flag means "nothing to report," never "safe." Never emit wording like "safe," "no risk" or "no interactions."

---

## 5. Data model: `data/nutrients.json`

Built from the Supabase export plus NIH fact sheets. One entry per nutrient:

```json
{
  "id": "vitamin-d",
  "name": "Vitamin D",
  "canonical_unit": "mcg",
  "synonyms": ["vitamin d", "vitamin d3", "cholecalciferol", "vitamin d2", "ergocalciferol"],
  "dsld_ingredient_groups": ["Vitamin D"],
  "unii_codes": ["1C6V77QF41"],
  "unit_conversions": [ { "from": "IU", "factor": 0.025, "applies_to_forms": ["*"] } ],
  "dri": {
    "rda": { "male": [ { "lower": 19, "upper": 70, "amount": 15 } ], "female": [ ... ] },
    "ear": { ... }, "ai": null,
    "ul": { "male": [ { "lower": 9, "upper": null, "amount": 100 } ], "female": [ ... ] }
  },
  "ul_scope": "total_intake",
  "ul_note": null,
  "factsheet_url": "https://ods.od.nih.gov/factsheets/VitaminD-HealthProfessional/",
  "source_url": "https://ods.od.nih.gov/factsheets/VitaminD-HealthProfessional/"
}
```

(The UNII code above is illustrative — take real codes from DSLD label data, not from this plan.)

**v1 scope:** the vitamins and minerals with DRIs — vitamins A, C, D, E, K, thiamin, riboflavin, niacin, B6, folate, B12, biotin, pantothenic acid, choline; calcium, chromium, copper, iodine, iron, magnesium, manganese, molybdenum, phosphorus, potassium, selenium, zinc. Keep everything the Supabase export has beyond that (including non-DRI compounds like omega-3s or melatonin) for recognition and overlap detection, with `dri: null`.

Add a `scripts/build-nutrients.ts` that converts the export, merges manual additions from `data/source/manual.json`, validates every entry against a JSON schema (every DRI value has a source, units are known, age ranges don't overlap), and fails the build otherwise.

---

## 6. Normalization and unit rules

Ingredient → nutrient matching, in order:
1. DSLD `ingredientGroup` matches `dsld_ingredient_groups`.
2. `uniiCode` matches `unii_codes`.
3. Exact, case-insensitive match of `name` or any `alternateNames`/`forms` against `synonyms`.
4. Otherwise → `unrecognized_ingredients`. No substring or fuzzy matching in v1.

Unit conversion (implement in `src/lib/units.ts` with tests; verify each against the nutrient's ODS fact sheet before relying on it):
- Same-dimension metric: g ↔ mg ↔ mcg.
- **Vitamin D:** 1 mcg = 40 IU.
- **Vitamin E:** IU → mg alpha-tocopherol depends on form: natural (d-alpha / RRR) ≈ 0.67 mg per IU; synthetic (dl-alpha / all-rac) ≈ 0.45 mg per IU. Unknown form → data gap.
- **Vitamin A (IU):** depends on form (retinol vs. beta-carotene). Convert only when the form is unambiguous; otherwise → data gap. Labels in mcg RAE need no conversion.
- **Folate:** labels may give mcg DFE. The UL applies to synthetic folic acid only; when the form is folic acid, folic acid mcg = DFE ÷ 1.7. Otherwise compare totals against RDA in DFE and say the UL couldn't be assessed.
- **Niacin** in mg NE vs. mg: treat supplement niacin as mg niacin; note the UL scope.
- Minerals: DSLD amounts are usually elemental. If a label clearly states compound weight, don't convert — report a data gap.
- Percent DV is reported as given, never used for totals.

UL scope (store in `ul_scope` and `ul_note`, and explain in responses):
- **Magnesium:** UL applies to supplements and medications only, not food.
- **Folate:** UL applies to folic acid from supplements and fortified foods.
- **Niacin:** UL applies to supplements and fortified foods.
- **Vitamin E:** UL applies to supplemental alpha-tocopherol (any form).
- **Vitamin A:** UL applies to preformed vitamin A (retinol and esters), not beta-carotene.
- Most others: total intake. Because the service only sees supplements, a supplement total under a total-intake UL does not mean total intake is under it; say so in `assumptions` whenever a UL is total-intake.

Blends: ingredients inside `nestedRows` without their own quantity → `BLEND_UNQUANTIFIED` gap; don't distribute the blend weight.

---

## 7. Tech stack and repo layout

- **Node.js 22 + TypeScript + Fastify 5** (handles chunked bodies; same language as SuppleTracker so the ported logic stays familiar).
- **Validation:** Zod or TypeBox schemas, which also generate the OpenAPI spec.
- **Cache:** in-memory LRU (`lru-cache`). Labels: 7-day TTL, max ~5,000 entries. Searches: 24-hour TTL. Optional SQLite file cache later.
- **DSLD client:** native `fetch`, base `https://api.ods.od.nih.gov/dsld/v9`, 6-second per-request deadline (`AbortSignal.timeout`), concurrency limit 4, one retry on network error. Optional `DSLD_API_KEY` env var sent as `X-Api-Key` (SuppleTracker sent one; confirm whether it's still required). The key lives on the backend, never in requests.
- **Tests:** Vitest. Record a handful of real DSLD label responses as fixtures in `test/fixtures/` so tests run offline.
- **No LLM calls and no vector database** in the request path.
- **Logging:** method, path, status, duration only. Never log request bodies (they can contain age, sex and a person's stack).

```
dietary-supplement-analysis/
├── PLAN.md
├── README.md                 # consumer docs + "How judges test this"
├── OPERATORS.md              # supplier runbook (card serving.docs)
├── Dockerfile                # node:22-slim, non-root, EXPOSE 8080
├── docker-compose.yml        # backend only; supplier stack lives in deploy/
├── package.json / tsconfig.json
├── src/
│   ├── server.ts             # Fastify app, routes, error handler
│   ├── routes/               # products.ts, nutrients.ts, stack.ts, tool.ts, meta.ts
│   ├── lib/
│   │   ├── dsld.ts           # DSLD client + cache
│   │   ├── label.ts          # DSLD label → normalized label (ported from addGlobalDSLDSupplement)
│   │   ├── match.ts          # ingredient → nutrient matching
│   │   ├── units.ts          # conversions
│   │   ├── dri.ts            # reference lookup (ported from CompTable)
│   │   ├── analyze.ts        # stack totals, overlaps, flags, gaps
│   │   └── errors.ts         # error codes → 4xx JSON
│   └── schemas/              # request/response schemas
├── data/
│   ├── nutrients.json        # built artifact, committed
│   └── source/               # Supabase export + manual additions
├── scripts/build-nutrients.ts
├── openapi/openapi.json      # generated, committed
├── card/card.json            # Pocket service card (< 4 KiB)
├── deploy/                   # Service Builder output: Caddyfile, relayer.yaml, miner.yaml,
│                             # supplier_stake_config.yaml, app_stake_config.yaml, pocket-ap.yaml
│                             # (templates only — no keys, mode-0600 files gitignored)
└── test/
```

---

## 8. Service card (`card/card.json`)

Must be valid `pocket-service-card/v1` JSON and under **4 KiB**. Validate with `pocketd tx service validate-card ./card/card.json` (or the Pocket MCP server) before registering.

Key fields:
- `description` (≤ 2,048 chars): discovery depends on this text, so open with a plain-language sentence that uses the words an agent would search for, e.g. *"Look up dietary supplement labels from the NIH Dietary Supplement Label Database and total vitamin and mineral intake across a list of supplements, compared with NIH recommended amounts (RDA) and daily upper limits (UL)."* Then: the four POST routes, request/response shapes in one line each, "results vary as DSLD updates," "not medical advice." Name the nearby Pocket drug services (`med-safety`, `fda`) as the place to check medications.
- `rpc_types`: `[{"type":"REST","intent":"expected","backend_hint":"dietary-supplement-analysis container on :8080, mounted at /","notes":"POST /v1/products/search, /v1/products/get, /v1/nutrients/reference, /v1/stack/analyze; GET /v1/health, /v1/version. All responses are JSON objects."}]`
- `apis`: `["dietary-supplement-analysis-api"]`
- `specs`: `[{"kind":"openapi","api":"dietary-supplement-analysis-api","url":"<raw GitHub URL of openapi/openapi.json at a tagged release>"}]`
- `access`: `public`; `results`: `variable`
- `serving.backend`, `serving.implementations` (`["dietary-supplement-analysis >= 0.1.0"]`), `serving.docs` (OPERATORS.md URL), `serving.min_disk_gb: 2`, `serving.min_ram_gb: 1`
- `serving.healthcheck`, in this order:
  1. `GET /v1/version` → `$.service` matches `^dietary-supplement-analysis$` (identity — the audit requires it to pin the service ID)
  2. `GET /v1/health` → `$.status` matches `^ok$`
  3. `POST /v1/nutrients/reference` with `{"nutrient":"vitamin-d","age":30,"sex":"female"}` → `$.nutrient.id` matches `^vitamin-d$` (functional, offline, deterministic)
- `serving.notes`: needs outbound HTTPS to `api.ods.od.nih.gov`; optional `DSLD_API_KEY`; max 15 products per analyze call; typical response under 3 s with warm cache; gateway relay timeout 30 s.
- `docs`: README URL. `updated`: today's date.

---

## 9. Build phases and timeline

Times are a guide for ~48 hours. **The deployment chain is the risk**, so get a stub backend registered, staked and settling early, then swap in the real one (same service ID, same card health checks).

### Phase 1 — Scaffold and stub (Saturday night, ~2 h)
- Repo, TypeScript, Fastify, Dockerfile, Vitest, lint.
- `/`, `/v1/health`, `/v1/version`, and `/v1/nutrients/reference` backed by a temporary 3-nutrient `nutrients.json`.
- Global error handler: every error → 4xx JSON; unexpected exceptions → 4xx `INVALID_INPUT` where caused by input, otherwise log and return a JSON body (avoid bare 5xx).
- **Owner task tonight:** export `global_compounds` from Supabase (§2a). Rent the VPS and point DNS (Phase 4) so certificates are ready tomorrow.

### Phase 2 — Data layer (Sunday morning, ~3 h)
- `scripts/build-nutrients.ts` from the Supabase export + fact sheets; schema validation; the 26 v1 nutrients complete with sources.
- `dri.ts` port with tests covering age-range edges, `null` bounds, each sex, and missing types.
- `units.ts` with tests for every rule in §6.

### Phase 3 — DSLD and analysis (Sunday midday, ~4 h)
- `dsld.ts` client with cache, concurrency limit, deadline, encoded params; record fixtures.
- `label.ts` normalization (all quantities, blends, statements, on-market).
- `match.ts`, `analyze.ts`, `/v1/products/search`, `/v1/products/get`, `/v1/stack/analyze`.
- Generate `openapi/openapi.json`; serve it at `/openapi.json`.
- Gateway-rule lint (see §10) passes.

### Phase 4 — Beta TestNet deployment (start Sunday morning in parallel; ~4 h of mostly waiting)
Use the Service Builder skill to render every file. Sequence:
1. **VPS:** Ubuntu 24.04, 2 vCPU, 4 GB RAM (3 GB is the floor), 4 GB swap, 25+ GB SSD, Docker + Compose v2, `ufw` allowing 22/80/443. Non-root `deploy` user.
2. **DNS:** `beta-supplement.<yourdomain>` → VPS (relay endpoint). Also `api-supplement.<yourdomain>` for the public demo route in step 10.
3. **Keys:** create owner, operator and application keys with `pocketd`. Fund each from https://faucet.beta.pocket.network/ (or `pocketd faucet fund upokt <key> --network=beta`). Send a small self-transfer from the operator so its public key is on-chain.
4. **Live parameters:** `pocketd query service params --network=beta`, `pocketd query supplier params --network=beta`, `pocketd query application params --network=beta`, `pocketd query shared params --network=beta`.
5. **Register:** `pocketd tx service add-service dietary-supplement-analysis "Dietary Supplement Label and Nutrient Intake Analysis" <CU> --card-file ./card/card.json --from $OWNER --network=beta --gas auto --gas-prices 1upokt --gas-adjustment 1.5`. **Record the tx hash.**
6. **Backend container** on the server's private Docker network: `expose: 8080`, `mem_limit`, `restart: unless-stopped`.
7. **Supplier stack:** HA RelayMiner `ghcr.io/pokt-network/pocket-relay-miner:v0.1.0` (relayer and miner on the same tag), Redis `8.10.1-alpine` with `noeviction`, `maxmemory`, appendonly volume; relayer with `validation_mode: eager`, `default_backend: rest`, `timeout_profile: fast`; miner `chain_id: pocket-lego-testnet`, `block_time_seconds: 30`. Never use `pocketd relayminer` or moving image tags. Health/metrics ports on loopback only.
8. **Caddy** terminates TLS on `beta-supplement.<domain>` → relayer.
9. **Stake supplier** with `rpc_type: REST` and `publicly_exposed_url: https://beta-supplement.<domain>`; stake the test application for `dietary-supplement-analysis`. **Record both tx hashes.** Wait one session.
10. **Relay test:** install `pocket-ap`; send real relays to each endpoint, with `--compare` against the backend. Then `pocketd query proof list-claims --supplier-operator-address <operator> --network=beta` until a claim **settles**. **Record the claim tx hash.**
11. **Public demo route for judges:** a separate Caddy site `api-supplement.<domain>` → backend, with a modest rate limit. Judges can't easily send signed relays; this lets them `curl` the service directly. Label it as a demo endpoint in the README.
12. Optionally run the Service Audit against Beta (https://mcp.pocketmcp.network/audit) to catch card and endpoint issues early, even though listing needs MainNet.

### Phase 5 — Swap in the full backend (Sunday evening)
- Deploy the full image to the same container name. Card health checks are unchanged, so no re-registration is needed. If the card text changed, republish it with `add-service` from the owner (gas only).
- Send another round of relays through `pocket-ap`; confirm a fresh claim settles.

### Phase 6 — Docs and submission (Monday, done by evening)
- README: pitch, endpoints, three copy-paste `curl` examples against the demo endpoint, one `pocket-ap` relay example, response field reference, limits, disclaimer, data sources and licenses.
- OPERATORS.md: how another supplier runs the backend; gateway snippet (`service id`, `type: passthrough`, `rpc_types: ["rest"]`, `relay_timeout: 30s`, health checks `/v1/version` critical and `/v1/health` major, 5 s, no sync checks).
- Tag `v0.1.0` and point the card's spec URL at the tagged OpenAPI file.
- Submit the form (fields below).

---

## 10. Acceptance checklist (Claude Code should verify each)

Backend:
- [ ] Every route, including 404s and validation errors, returns a body whose first byte is `{`. Test with `curl -s ... | head -c1`.
- [ ] No route returns 5xx for any input in the test suite (fuzz invalid bodies).
- [ ] `GET /` and `HEAD /` → 2xx. Chunked POST bodies parse.
- [ ] `/v1/version` returns exactly `{"service":"dietary-supplement-analysis","version":...}`.
- [ ] The first 2 KB of every success body contains none of the gateway error phrases in §4.
- [ ] p95 latency under 5 s for a 10-product analyze with a cold cache; under 1 s warm.
- [ ] No request bodies in logs.
- [ ] Unit tests: DRI lookup, every conversion rule, blend handling, unrecognized ingredients, IU vitamin A gap, magnesium UL scope, default servings assumption.
- [ ] Golden test: a 3-product stack fixture produces a reviewed, committed JSON snapshot.
- [ ] Wording check: no response contains "safe," "no risk" or "no interactions."

Pocket:
- [ ] Card validates, is under 4 KiB, and its health checks pass against the live endpoint.
- [ ] Staked endpoint is `https://` on a hostname with a publicly trusted certificate; `rpc_type` REST matches the card.
- [ ] A relay via `pocket-ap` matches a direct call (`--compare`).
- [ ] At least one settled claim on Beta TestNet.

---

## 11. Hackathon submission form

The form asks for these (all required):

| Field | What to enter |
|---|---|
| Name, Email, Discord Username | Yours |
| Service Name | Dietary Supplement Label and Nutrient Intake Analysis |
| Service Description | 2–3 sentences from the pitch in §1 |
| Testnet Service ID | `dietary-supplement-analysis` |
| Endpoint URL | `https://beta-supplement.<domain>` (the staked relay endpoint). Mention the demo endpoint in the testing notes. |
| Test Transaction ID | The form doesn't say which. Keep hashes for registration, supplier stake, application stake and the settled claim; submit the claim (or a relay) hash and ask in the Pocket Discord which one judges want. |
| Repository Link | GitHub repo URL |
| How should judges test your service? | Demo-endpoint `curl` for `/v1/stack/analyze` with a ready-made 3-product stack; a `pocket-ap` relay command; note the 15-product cap and offline `/v1/nutrients/reference` |
| Category | Data service |

Example for judges (fill in real DSLD IDs found during Phase 3):
```bash
curl -s https://api-supplement.<domain>/v1/stack/analyze \
  -H 'Content-Type: application/json' \
  -d '{"age":34,"sex":"female","products":[{"dsld_id":<id1>},{"dsld_id":<id2>},{"name":"Custom magnesium","ingredients":[{"name":"magnesium","amount":250,"unit":"mg"}]}]}'
```

---

## 12. Risks and how to handle them

| Risk | Mitigation |
|---|---|
| Deployment chain takes longer than expected (sessions, claim settlement) | Stub backend registered and staked by Sunday morning; real backend swapped in later |
| DSLD slow, rate-limited or down | Cache, concurrency limit 4, 6 s deadline, pre-warm fixtures' IDs at startup; 424 `UPSTREAM_UNAVAILABLE` with `retryable: true` only when nothing is cached |
| Wrong DRI or conversion values | Every value carries a fact-sheet source; build script validates; unit tests; prefer a data gap over a guess |
| Supabase export missing or messy | Build the 26 v1 nutrients from ODS fact sheets directly |
| Service ID taken on Beta | Check before registering; fallback ID ready |
| Health framing | Disclaimer on every response, gaps instead of guesses, no "safe" wording, interactions explicitly out of scope |
| Privacy | Age, sex and stack are the only personal inputs; nothing stored or logged |

## 13. After the hackathon

MainNet registration (≈1,000 POKT fee) and supplier stake (59,500 POKT minimum), MainNet settled claim, Service Audit pass, listing request to directors@pokt.foundation. Then: use the same API inside SuppleTracker so the website and the agent service share one engine, add openFDA dietary-supplement adverse-event counts (clearly caveated), pregnancy/lactation references, and an MCP tool route.
