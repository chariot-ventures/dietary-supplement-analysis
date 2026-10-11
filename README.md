# Dietary Supplement Label and Nutrient Intake Analysis

AI assistants call this service when someone asks "is my supplement routine OK?". Give it the products the way a person names them (product name, barcode or NIH label ID), with age and sex, and optionally their medications, conditions and what they eat. It finds each label in the NIH Dietary Supplement Label Database, totals every vitamin and mineral per day across all of them, and compares the totals with NIH reference intakes and upper limits. It also reports the medication interactions named in the NIH fact sheets, herbs with NIH safety signals, and FDA recalls and adverse event reports. Every answer starts with a plain-language summary an assistant can relay (English or Spanish), and every number traces back to its label or NIH source.

It runs on Pocket Network Beta TestNet as the paid service `dietary-supplement-analysis`, and as a remote MCP server with a free trial.

| | |
|---|---|
| Try it | [For judges: try it in one minute](#for-judges-try-it-in-one-minute) |
| Pocket Network | Service ID `dietary-supplement-analysis` on Beta TestNet, relay endpoint `https://pokt-beta.trackmysupplement.com`. Passes all 9 Pocket portal acceptance rules, with a paid relay settled on-chain ([record](#on-chain-record-beta-testnet)) |
| MCP server | `https://agents.trackmysupplement.com/mcp`, listed in the [official MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=dietary-supplement-analysis) and on [Smithery](https://smithery.ai/servers/chariot-ventures/dietary-supplement-analysis). See [mcp/README.md](mcp/README.md) |
| Accuracy | 56 hand-worked cases, all passing ([EVAL.md](EVAL.md)) |
| Running version | [`/v1/version`](https://agents.trackmysupplement.com/v1/version); every release is in [CHANGELOG.md](CHANGELOG.md) |
| Run a supplier or gateway | [OPERATORS.md](OPERATORS.md): a multi-arch image is published for every release |

**Data sources**, all public:

- **Labels:** [NIH Dietary Supplement Label Database (DSLD)](https://dsld.od.nih.gov/), API v9 plus a weekly mirror of NIH's full download (214,782 labels).
- **Reference values:** Food and Nutrition Board DRIs, as published on the [NIH Office of Dietary Supplements fact sheets](https://ods.od.nih.gov/factsheets/list-all/).
- **Interactions and herbs:** NIH ODS and [NCCIH](https://www.nccih.nih.gov/health/herbsataglance) fact sheets; medication names are normalized with NIH RxNorm.
- **Recalls and adverse events:** [openFDA](https://open.fda.gov/).
- **Foods:** USDA SR28 (FoodData Central "SR Legacy"); typical US intake from What We Eat in America, NHANES 2017–March 2020.

**What it is not:** medical advice or a diagnosis. It reports what labels declare, compares the totals with published reference values, and relays the interactions and safety statements NIH publishes. The interaction list is not exhaustive, and no flag means nothing was found to report, not an all-clear.

## For judges: try it in one minute

| | |
|---|---|
| Service ID | `dietary-supplement-analysis` (Pocket Network Beta TestNet, `rpc_type: REST`, 500 compute units per relay) |
| Relay endpoint (staked supplier) | `https://pokt-beta.trackmysupplement.com`. Accepts signed Pocket relays only. |
| Demo endpoint (direct, free trial) | `https://agents.trackmysupplement.com`. The same backend without the relay layer, so you can use `curl`. Up to 30 requests a minute and 100 calls a day per client ([details](#limits)); over a limit it returns `429` with `"code":"RATE_LIMITED"` and a `Retry-After` header. |

Each example is one call, made the way an assistant would make it after a user describes their routine in plain words. `jq -r .agent_summary` prints the answer the assistant relays; a trimmed copy of the live answer is shown under each one.

**1. "I'm 74 and on Coumadin. I take Centrum Silver, fish oil and ginkgo."**

```bash
curl -s https://agents.trackmysupplement.com/v1/stack/analyze -H 'Content-Type: application/json' -d '{
  "age": 74, "sex": "female", "detail": "summary", "medications": ["Coumadin"],
  "products": [{"query": "Centrum Silver Women 50+"}, {"query": "Nature Made Fish Oil 1200 mg"}, {"query": "Ginkgo Biloba 120 mg"}]}' | jq -r .agent_summary
```

> Ginkgo (in Nutricost Ginkgo Biloba 120 mg): NCCIH: ginkgo may increase the risk of bleeding in people taking anticoagulants such as warfarin. Coumadin with Vitamin K in this stack: Vitamin K counteracts warfarin; NIH describes a serious and potentially dangerous interaction. Coumadin with Vitamin E in this stack: … Coumadin with EPA/DHA in this stack: High-dose fish oil may prolong clotting time and raise INR … 1 more interaction finding in interactions.findings.

The brand name is recognized as warfarin, three products are found by name in the NIH label database, and every warning cites its NIH or NCCIH fact sheet.

**2. "I'm pregnant. I take a prenatal, vitamin A 25,000 IU for my skin, and ashwagandha for stress."**

```bash
curl -s https://agents.trackmysupplement.com/v1/stack/analyze -H 'Content-Type: application/json' -d '{
  "age": 29, "sex": "female", "life_stage": "pregnancy", "detail": "summary",
  "products": [{"query": "Nature Made Prenatal Multi + DHA"}, {"query": "vitamin A 25000 IU"}, {"query": "ashwagandha root extract"}]}' | jq -r .agent_summary
```

> Vitamin A: 7500 mcg a day vs a UL of 3000 mcg (250%) … The UL guards against liver damage, and birth defects when taken in pregnancy (preformed vitamin A only). Leaving out … Vitamin A 25000 IU would bring Vitamin A to 0 mcg. Ashwagandha: … NCCIH: avoid ashwagandha during pregnancy and while breastfeeding.

**3. "I'm 62: Centrum Silver, fish oil, magnesium and zinc. Should I add vitamin D 5000?"** With `"diet": "typical"`, food is counted too.

```bash
curl -s https://agents.trackmysupplement.com/v1/stack/analyze -H 'Content-Type: application/json' -d '{
  "age": 62, "sex": "female", "diet": "typical",
  "products": [{"query": "Centrum Silver Women 50+"}, {"query": "Nature Made Ultra Fish Oil 1400"},
               {"query": "KAL Magnesium Glycinate 400"}, {"query": "Thompson Zinc 50 mg", "servings_per_day": 1}],
  "candidates": [{"query": "vitamin d3 5000 iu"}]}' | jq -r .agent_summary
```

> Zinc: 65 mg a day vs a UL of 40 mg (163%), mostly from Thompson Zinc 50 mg. The UL guards against reduced copper status … Magnesium: 500 mg a day vs a UL of 350 mg (143%) … Leaving out Thompson Zinc 50 mg would bring zinc to 15 mg (37.5% of the UL). … Adding … Vitamin D3 5000 IU would put Vitamin D (150% of the UL) above the upper limit.

The answer gives the one change that fixes it, and the what-if answers the question the user actually asked.

**4. In Spanish: "Tomo Centrum Silver y Caltrate; tomo warfarina y levotiroxina."**

```bash
curl -s https://agents.trackmysupplement.com/v1/stack/analyze -H 'Content-Type: application/json' -d '{
  "age": 68, "sex": "female", "lang": "es", "detail": "summary", "medications": ["warfarina", "levotiroxina"],
  "products": [{"query": "Centrum Silver Women 50+"}, {"query": "Caltrate 600+D3"}]}' | jq -r .agent_summary
```

> Warfarina con vitamina K de este conjunto: La vitamina K contrarresta la warfarina … Levotiroxina con calcio de este conjunto: … No tome la levotiroxina dentro de las 4 horas del carbonato de calcio. Levotiroxina con hierro de este conjunto: …

**5. Scan a bottle:** a barcode finds the label, and the same barcode finds FDA recalls and adverse event reports.

```bash
curl -s https://agents.trackmysupplement.com/v1/products/lookup -H 'Content-Type: application/json' -d '{"upc":"031604026974"}' | jq -r '.product.brand + " " + .product.name'
curl -s https://agents.trackmysupplement.com/v1/products/fda -H 'Content-Type: application/json' -d '{"upc":"031604026974"}' | jq -r .agent_summary
```

For a product with recalls, try `{"query":"Nature Made Vitamin D3 1000 IU"}`: FDA lists 4 matching recalls.

**6. In Claude, or any MCP client:** add `https://agents.trackmysupplement.com/mcp` as a custom connector (no key needed for the free trial) and ask in plain words, for example "I take Centrum Silver and 5000 IU of vitamin D and I'm on warfarin. Anything I should know?". The assistant calls `stack_analyze` and answers with the citations. See [mcp/README.md](mcp/README.md), including a local bridge that pays per call through Pocket Network.

**More calls:** `POST /v1/nutrients/reference` (RDA and UL for one nutrient, offline), `POST /v1/products/search` (find labels), `POST /v1/interactions/check` (medications without a stack), and `GET /v1/tools`, `GET /v1/guide` and `GET /openapi.json` for agent frameworks. All are listed under [Endpoints](#endpoints).

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

## Why it matters for Pocket Network

- **A question millions of people have.** 60.2% of US adults took a dietary supplement in the past 30 days, 38.7% took two or more, and 75.9% of adults 60 and older took at least one ([CDC NCHS, 2021–2023](https://www.cdc.gov/nchs/products/databriefs/db561.htm)). Health, pharmacy, grocery and fitness assistants all get asked whether a routine is OK, and a good answer needs the exact amounts on each label and the NIH limits for that person, which a model alone doesn't have.
- **Repeat calls.** Each question is one relay (500 compute units). A conversation usually brings more: the product the user is considering, a scanned barcode, an FDA check, a new prescription.
- **Fills a gap next to Pocket's own health services.** Pocket's catalog has drug services (`fda`, `med-safety`, `clinical-trials`) but nothing for supplements, which most of those users also take. An agent that already calls those services for prescriptions can call this one for everything else in the cabinet.
- **A free trial that leads to paid relays.** The MCP server is listed in the official MCP Registry, on Smithery and on mcpservers.org. Its free trial (25 checks a day per connection) is enough for a person to try it, and every limit message points agents with real volume to the Pocket route, which is never metered.
- **Ready for more suppliers.** A multi-arch image is published for every release, [OPERATORS.md](OPERATORS.md) sets up a supplier in about 5 minutes, and responses never use 5xx, so gateways don't mistake a bad input for a faulty supplier.
- **Checked.** 56 hand-worked cases pass on every release ([EVAL.md](EVAL.md)), and the live service is tested every 30 minutes against the public endpoint and the Pocket portal audit.

## Endpoints

All inputs come from the JSON request body. All responses are JSON objects, errors included.

| Method | Path | Purpose |
|---|---|---|
| GET/HEAD | `/` | Service identity |
| GET | `/v1/version` | `{"service":"dietary-supplement-analysis","version":"0.12.5"}` |
| GET | `/v1/health` | `{"status":"ok"}` |
| GET | `/openapi.json` | OpenAPI 3.1 spec (also at [openapi/openapi.json](openapi/openapi.json)) |
| POST | `/mcp` | Remote MCP server (Streamable HTTP, stateless): the same tools for MCP clients |
| GET | `/v1/provenance` | Code version, git commit and the edition of each data source |
| GET | `/v1/tools` | Tool definitions (`name`, `description`, JSON Schema `input_schema`) for function calling |
| GET | `/v1/guide` | Usage guide for agents, as markdown inside JSON (same text as [llms.txt](llms.txt)) |
| POST | `/v1/stack/analyze` | One call: per-nutrient totals across 1–15 products (names, barcodes, IDs or custom), flags, fixes, what-if candidates |
| POST | `/v1/interactions/check` | NIH-listed nutrient interactions for medications or conditions, no stack needed: `{"medications":["Synthroid"],"nutrients":["calcium"]}` |
| POST | `/v1/products/search` | Find products in DSLD: `{"query":"vitamin d3 5000","brand":"NOW","limit":5}`; label versions collapsed |
| POST | `/v1/products/lookup` | Label for a barcode: `{"upc":"031604026974"}` |
| POST | `/v1/products/fda` | FDA recalls and adverse event reports (openFDA) for one product: `{"query":"Nature Made D3 1000 IU"}`, `{"upc":...}`, `{"dsld_id":...}` or `{"brand":...,"name":...}` |
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
  "medications": [ "warfarin", "Synthroid 50 mcg" ],
  "conditions": [ "smoker" ],
  "candidates": [ { "query": "vitamin d3 5000 iu" } ]
}
```

- **Products** (1–15) can be a product name (`query`, optionally with `brand`), a barcode (`upc`), a DSLD ID, or a custom product with explicit ingredients. Custom ingredients may give a `form` (for example `"folic acid"` or `"d-alpha tocopherol"`) so IU and DFE conversions can be applied.
- **Names and barcodes** are resolved server-side. A name is matched against DSLD search results by the share of its words found in the brand and product name; label versions of the same product are collapsed and the newest on-market one is used. `resolutions[]` records each match with `confidence` (`high`: every word matched one product; `medium`: every word matched but other products did too, or most words matched; `low`: under 60%) and up to three alternatives. A product that can't be identified is reported (`PRODUCT_NOT_RESOLVED`) and left out; the call fails with 404 only when nothing could be identified.
- **`diet: "typical"`** adds the US average daily intake from food and drinks for the age and sex (What We Eat in America, NHANES 2017–March 2020) and repeats the comparisons in `with_typical_diet`. Food counts toward a UL only where the UL covers it: all of it for total-intake ULs, food folic acid for folate, retinol for vitamin A, added vitamin E for vitamin E, none for magnesium. It isn't applied under age 2 or in pregnancy and lactation.
- **`medications`** (up to 30, generic or brand names as the user gives them) are matched to 46 drug classes and checked against the 55 medication interactions listed in the NIH Office of Dietary Supplements fact sheets ([data/interactions.json](data/interactions.json)). Names the list doesn't know are normalized to their ingredient with NIH RxNorm (RxNav) when the service can reach it; matching is whole-word, never fuzzy. `interactions.findings[]` gives each interaction's kind (`supplement_changes_drug`, `drug_lowers_nutrient`, `drug_raises_nutrient`, `additive_risk`, `two_way`), NIH's timing advice where it gives any, the fact sheet, and `in_stack` with the products involved; in-stack findings come first and lead `agent_summary`. The list is not exhaustive (`INTERACTIONS_PARTIAL`), and medication names are never logged.
- **Botanicals.** Herbs and other non-nutrient ingredients with NIH safety signals (16 so far: ashwagandha, kava, St. John's wort, ginkgo, green tea extract, turmeric/curcumin, black cohosh, garcinia cambogia, red yeast rice, goldenseal, berberine, yohimbe, ephedra, valerian, echinacea, creatine) are reported in `botanicals[]` with the NCCIH or ODS statement, the pregnancy statement, and dose checks where NIH cites doses (creatine above 5 g and 25 g a day, EGCG at 843 mg a day, valerian above 600 mg a day). They're matched on DSLD's ingredient group or the exact name after dropping plant-part and preparation words ("Ashwagandha Root Extract" is ashwagandha), never by substring ([data/botanicals.json](data/botanicals.json)). With `medications`, botanical-drug pairs NIH names (St. John's wort with birth control, warfarin or SSRIs; ginkgo with anticoagulants; kava and valerian with sedatives; red yeast rice with statins; goldenseal with metformin) become interaction findings.
- **`conditions`**: `smoker` (current or former, or asbestos exposure: beta-carotene from 20 mg a day, counting vitamin A declared as beta-carotene), `kidney_disease` (potassium, magnesium, phosphorus), `hemochromatosis` (iron; vitamin C from 500 mg), `lab_test_soon` (biotin from 1 mg skews thyroid, troponin and other tests), `cancer_treatment` (high-dose vitamin C and E).
- **`foods`** (up to 30) lists what the person eats in a day: `{"query": "spinach cooked", "amount": 1, "unit": "cup"}` or `{"query": "whole milk", "grams": 488}` or `{"ndb_number": "11458", "grams": 180}`. Foods are matched offline against the 8,789 foods of USDA SR28 (FoodData Central's "SR Legacy"), using whole words and the USDA household portions, and added to the supplement totals in `nutrient_totals[].with_foods`. Nutrients only the foods supply are checked in `foods.totals`. Food counts toward a UL only where the UL covers food, as for `diet`. Nutrients USDA didn't analyze for a food are listed, not assumed zero; three SR28 manganese values that are off by orders of magnitude are excluded and reported. Use `foods` or `diet: "typical"`, not both.
- **`timing`** lists the NIH timing statements that apply to the stack, each naming its products and fact sheet: calcium in doses of 500 mg or less, calcium carbonate with a meal, separate calcium and iron supplements, 25 mg+ iron apart from zinc, iron with food at high doses, vitamin D with some fat, green tea extract with food, and medication spacing for in-stack interactions. The first one also appears in `agent_summary`.
- **`lang: "es"`** writes `agent_summary` in Spanish, with the English text kept in `agent_summary_en`. Every NIH phrase that can appear in a summary has a reviewed Spanish translation ([data/i18n-es.json](data/i18n-es.json)); other fields stay in English. Medication names can be given in Spanish (warfarina, levotiroxina, omeprazol) or as Spanish and Latin American brands (Sintrom, Eutirox), with or without accents.
- **`detail: "summary"`** returns only what an agent needs to answer (`agent_summary`, `flagged` nutrients, `suggestions`, `resolutions`, candidate verdicts, `data_gap_codes`, `provenance`), typically 1–3 KB instead of 20–40 KB.
- **Candidates** (up to 5) are products the user is considering. Each is evaluated as an addition to the stack in `candidate_results[]` and isn't counted in the totals.
- `servings_per_day` defaults to the label's maximum daily servings, or 1 if the label doesn't say. Every default is listed in `assumptions`.
- `age` and `sex` are optional. Without them you get totals and overlaps, but no reference comparisons.
- `life_stage` (`"pregnancy"` or `"lactation"`, female, ages 14–50) switches to the pregnancy or lactation reference values; `"pregnant": true` and `"breastfeeding": true` work too. For infants, give the age as a fraction of a year (`0.25` is 3 months): the 0–6 and 7–12 month values apply.

The response contains, in this order: `profile`, `summary`, `agent_summary`, `resolutions` (when names or barcodes were given), `assumptions`, `suggestions`, `candidate_results` (when candidates were given), `botanicals` (when the stack has any with NIH signals), `interactions` (when medications or conditions were given), `nutrient_totals`, `overlaps`, `unrecognized_ingredients`, `data_gaps`, `products`, `sources` and `disclaimer`.

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
| `with_typical_diet` | With `"diet": "typical"`: `food`, `estimated_total`, `amount_toward_ul`, `percent_of_ul`, `coverage` and `flags` with US average food intake added |

### Errors

```json
{ "error": { "code": "INVALID_INPUT", "message": "products: ...", "retryable": false, "field": "products" } }
```

| Code | Status | When |
|---|---|---|
| `INVALID_INPUT` | 400 | Malformed or out-of-range input |
| `NOT_FOUND` | 404 | Unknown DSLD ID, nutrient or route |
| `UNSUPPORTED` | 422 | Pregnancy or lactation outside ages 14–50 |
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
| `INTERACTIONS_NOT_ASSESSED` | No `medications` were given, so medication interactions weren't checked. Supplement-to-supplement interactions are never evaluated |
| `INTERACTIONS_PARTIAL` | Medications were checked, but only against the interactions named in the NIH ODS fact sheets; the list is not exhaustive |
| `FOOD_NOT_RESOLVED` | A food in `foods` matched no USDA SR28 food and isn't counted |
| `FOOD_PORTION_UNKNOWN` | USDA lists no portion for the unit given for that food; the listed portions are in `foods.items[].portions` (give grams instead) |
| `FDA_UNAVAILABLE` | `/v1/products/fda` only: openFDA couldn't be reached for recalls or adverse events; the rest of the answer stands |
| `MEDICATION_NOT_RECOGNIZED` | A medication name matched no class in the NIH fact sheet interaction list (directly or through RxNorm), so nothing was checked for it |

## How the numbers are produced

Accuracy is checked against 56 hand-worked cases; see [EVAL.md](EVAL.md).

- **Reading DSLD labels:**
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
| `DSLD_API_KEY` | none | An [api.data.gov key](https://api.data.gov/signup/), sent to DSLD as `X-Api-Key` (raises NIH's limit from 1,000 to 10,000 requests an hour) |
| `OPENFDA_API_KEY` | none | The same api.data.gov key, for openFDA |
| `OPENFDA` / `RXNORM` | on | `off` stops calls to openFDA or RxNorm (medication matching then uses only the names in [data/interactions.json](data/interactions.json)) |
| `FREE_TIER_HOSTS` | none | Host names that get the free-trial quotas (the demo uses `agents.trackmysupplement.com`); requests on other hosts, such as Pocket relays, are never metered. `FREE_TIER_PER_SESSION`, `FREE_TIER_PER_IP`, `FREE_TIER_PER_IP_MCP` and `FREE_TIER_GLOBAL` change the quotas |
| `DSLD_BASE_URL` | `https://api.ods.od.nih.gov/dsld/v9` | DSLD API base |
| `DSLD_PREWARM_IDS` | none | Comma-separated label IDs to cache at startup |
| `DSLD_STORE_PATH` | `/data/dsld.sqlite` in the container, off otherwise | Persistent label store (SQLite). Every fetched label is kept; when NIH is unreachable, labels, barcodes and searches are answered from it. Empty turns it off |
| `DSLD_WARM` | `1` | With the store on, a background job fetches popular products into it at about one request per second (queries in [data/warm-queries.json](data/warm-queries.json)). `0` turns it off |
| `DSLD_FIXTURES_DIR` | none | Serve DSLD from local `label-<id>.json` files (dev only; `test/fixtures/dsld/real` holds 12 real labels) |
| `UPSTREAM_BUDGET_MS` | `8000` | Total time one request may spend waiting on DSLD before answering `424` |
| `LOG_LEVEL` | `info` | Logs record method, path, status and duration only, never request bodies |

## Limits

- Up to 15 products and 5 candidates per analyze call, 10 IDs per get call, and 10 search results.
- **NIH's full DSLD download (214,782 labels) is mirrored** into the label store and refreshed weekly when NIH publishes a new one. Labels and barcodes in the mirror are answered without calling NIH. Name searches use the live API (with an api.data.gov key) and fall back to the mirror, switching to it automatically for 10 minutes whenever NIH rate-limits. `GET /v1/provenance` shows the mirrored version.
- DSLD calls run at most 4 at a time, with a 6 s deadline each and an 8 s budget per request. Labels are cached in memory for 7 days and searches for 24 hours, and labels are also kept in the persistent label store (refreshed after 30 days). If DSLD is down, stale copies and the label store answer instead; search results from the store say `"search_source": "local"`. Measured against live DSLD: a cold 15-product analyze takes 1.5 s and a warm one 17 ms.
- Text that Pocket gateways treat as an error signal ("timeout", "block not found" and others) is `\u`-escaped in responses. It decodes to the same string.
- Ages from birth to 120, plus pregnancy and lactation (14–50). Caffeine is checked against FDA guidance (400 mg a day for healthy adults, under 200 mg in pregnancy) and sodium against the 2019 Chronic Disease Risk Reduction Intake (2,300 mg), neither of which is a DRI UL; the response says so in `ul_note`.
- **The public demo endpoint is a free trial.** It allows 30 requests per minute per client, plus daily quotas that reset at 00:00 UTC:
  - 25 tool calls per MCP connection (each connection gets its own `Mcp-Session-Id`), at most 20 a minute;
  - 100 REST calls per IP;
  - 1,000 MCP calls per IP (hosted clients such as claude.ai share egress addresses);
  - 5,000 free calls in total.
  Discovery (`GET` routes, `initialize`, `tools/list`) is free. Results are never degraded. REST responses carry `X-Free-Tier-Remaining`, `X-Free-Tier-Limit` and `X-Free-Tier-Reset` headers, and MCP results carry the same in `_meta.free_tier`. Past a quota, REST answers `429 RATE_LIMITED`, and MCP returns a readable tool result saying when the quota resets and how to switch to the paid Pocket route.
  - Counters are salted hashes, kept for two days.
  - Relays through Pocket Network are never metered.

## Disclaimer and licenses

Information from labels and published reference data, not medical advice. Totals cover supplements only unless `diet` or `foods` is given; medications are checked for interactions, not counted. DSLD, ODS, NCCIH, RxNorm, openFDA and USDA content are U.S. Government works. No license has been chosen for the code yet.
