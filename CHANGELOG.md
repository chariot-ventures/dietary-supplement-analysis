# Changelog

## 0.8.0 (2026-10-11)

- **New: `POST /v1/products/fda`** (tool `products_fda_reports`): FDA recalls and CAERS adverse event reports for one supplement from openFDA, by name, barcode, DSLD ID, or brand and name. A recall is listed only when it carries the product's barcode or the brand and every distinctive name word; recalls that only mention the brand are counted. Adverse event reports are counted with their most common reactions, with FDA's caveat that a report does not show causation. Cached for a day; `OPENFDA_API_KEY` raises openFDA's daily limit; `OPENFDA=off` turns it off.

## 0.7.0 (2026-10-11)

- **Botanicals.** 16 herbs and other non-nutrients with NIH NCCIH/ODS safety signals are reported in `botanicals[]`: liver injury (ashwagandha, kava, black cohosh, garcinia, green tea extract, bioavailable curcumin), bleeding (ginkgo), drug interactions (St. John's wort, goldenseal), statin-like effects (red yeast rice), heart risks (yohimbe), the 2004 ephedra ban, sedation (kava, valerian) and allergies (echinacea), each with its pregnancy statement. Matching is exact on the DSLD ingredient group or the name without plant-part words.
- **Dose checks** where NIH cites doses: creatine (3–5 g a day maintenance; 25 g the highest studied), EGCG (843 mg a day raised liver enzymes in the Minnesota Green Tea Trial), valerian (300–600 mg a day short-term).
- **Botanical-drug interactions** NIH names (St. John's wort with birth control, warfarin, SSRIs and others; ginkgo with anticoagulants; kava and valerian with sedatives; red yeast rice with statins; goldenseal with metformin; ashwagandha with thyroid, diabetes and blood pressure drugs) join `interactions.findings` with `botanical_ids`; `/v1/interactions/check` lists them too and its `nutrients` filter accepts botanical names.

## 0.6.0 (2026-10-11)

- **Medication interactions.** `/v1/stack/analyze` takes `medications` (generic or brand names, as the user says them, up to 30). Each is matched to a drug class (35 classes; NIH RxNorm normalizes names the list doesn't know) and checked against the 55 interactions listed in the NIH ODS fact sheets, with timing advice where NIH gives it. Findings involving a nutrient the stack supplies come first, cite their fact sheet, and lead the `agent_summary`. Never logged.
- **Conditions.** `conditions`: `smoker` (beta-carotene from 20 mg), `kidney_disease` (potassium, magnesium, phosphorus), `hemochromatosis` (iron, vitamin C from 500 mg), `lab_test_soon` (biotin from 1 mg), `cancer_treatment` (antioxidant doses).
- **New: `POST /v1/interactions/check`** (tool `interactions_check`): NIH-listed interactions for medications or conditions without a stack, optionally filtered by nutrient.
- New data gap codes `INTERACTIONS_PARTIAL` and `MEDICATION_NOT_RECOGNIZED`; `INTERACTIONS_NOT_ASSESSED` now appears only when no medications were given.

## 0.5.0 (2026-10-11)

- **Remote MCP server** at `POST /mcp` (Streamable HTTP, stateless): the same five tools for Claude, claude.ai connectors, Cursor and other MCP clients. `stack_analyze` defaults to the compact summary there. [mcp/dsa-mcp.mjs](mcp/dsa-mcp.mjs) is a zero-dependency stdio bridge that can send every call through Pocket Network via a local `pocket-ap` listener. [mcp/server.json](mcp/server.json) is ready for the official MCP Registry.
- **`detail: "summary"`** on `/v1/stack/analyze`: a 1–3 KB answer with the summary, flagged nutrients, suggestions, resolutions and candidate verdicts.
- **Provenance:** every analysis carries the code version, git commit and reference-data review date; `GET /v1/provenance` lists the edition of each data source. The auto-deploy passes the commit into the image.

## 0.4.1 (2026-10-11)

- `DATA_SUSPECT` `duplicate_row` no longer fires when the repeated rows declare different forms (for example calcium as carbonate and as citrate).

## 0.4.0 (2026-10-11)

- **Typical diet estimate.** `"diet": "typical"` adds the US average daily intake from food and drinks for the person's age and sex (What We Eat in America, NHANES 2017–March 2020, Table 1) to the supplement totals, and repeats the UL and RDA comparisons in each nutrient's `with_typical_diet`. Food counts toward a UL only where that UL covers food (folate: food folic acid; vitamin A: retinol; vitamin E: added vitamin E; magnesium: none). `agent_summary` names nutrients that reach the UL only once food is included, for example calcium from a 1,200 mg supplement plus a typical diet at 62.

## 0.3.0 (2026-10-11)

- **Pregnancy, lactation and infants.** `life_stage` (`"pregnancy"` or `"lactation"`, female, ages 14–50; `"pregnant": true` and `"breastfeeding": true` also work) switches to the Food and Nutrition Board's life-stage values. Ages under 1 (as a fraction of a year) use the 0–6 and 7–12 month values. These were `422 UNSUPPORTED` before.
- **More nutrients:** chloride and fluoride (DRIs), sodium (AI, with the 2019 Chronic Disease Risk Reduction Intake of 2,300 mg as its limit), and caffeine (FDA's 400 mg a day for healthy adults; under 200 mg in pregnancy). For sodium and caffeine, `ul_note` says the limit isn't a DRI UL.
- **Persistent label store.** Every NIH label the service fetches is kept in SQLite (Node's built-in `node:sqlite`), and a background job fills it with popular products at about one request per second. When NIH's API is slow or down, labels, barcodes and searches are answered from the store (`"search_source": "local"`). The container keeps it on a volume at `/data`.

## 0.2.0 (2026-10-11)

One call now goes from what a user says to what they should look at.

- **Products by name or barcode.** `/v1/stack/analyze` accepts `{"query": "Centrum Silver Women 50+"}` and `{"upc": "031604026974"}` as well as DSLD IDs and custom products. Each is resolved server-side and reported in `resolutions[]` with a confidence level and alternatives. A product that can't be identified is reported and skipped instead of failing the call.
- **New: `POST /v1/products/lookup`** finds a label by barcode.
- **Label versions collapsed.** `/v1/products/search` returns one result per product (the newest on-market version) with `entry_date` and `other_versions`. Pass `"dedupe_versions": false` for every version.
- **Flags an agent can act on.** `near_ul` (90–100% of the UL) joins `above_ul`, each flagged nutrient has a `severity` (`high`, `moderate`, `low`), and `reference.ul_basis` says what the UL protects against.
- **Breaking:** the `below_reference` flag and `summary.below_reference` are gone. Supplements alone are usually below the RDA by design, so the flag was noise. Each nutrient now has an informational `coverage` (percent of the RDA or AI from supplements alone) instead.
- **Fixes, not just warnings.** `suggestions[]` lists single-product changes (fewer servings, or leaving a product out) that would bring an above-UL nutrient back under its UL, with the resulting amount.
- **What-if.** Up to 5 `candidates` are evaluated as additions to the stack in `candidate_results[]`.
- **`agent_summary`**: two to five plain sentences, generated deterministically from the numbers.
- **Data checks.** `DATA_SUSPECT` gaps flag NIH label records that look wrong: the same ingredient twice under one heading, nested amounts over their total, a %DV that contradicts the amount, or an amount over 50 times the highest adult UL.
- **Discovery.** `GET /v1/tools` (tool definitions with JSON Schema inputs), `GET /v1/guide` and [llms.txt](llms.txt) (usage guide), and request examples in the OpenAPI spec.
- **Operations.** Releases deploy themselves to the supplier server: a new `vX.Y.Z` tag, or a push to the `release` branch with a higher version ([deploy/autodeploy/](deploy/autodeploy/)).

## 0.1.0 (2026-10-11)

First release: DSLD search and labels, nutrient reference values, stack analysis with above-UL flags, data gaps and sources.
