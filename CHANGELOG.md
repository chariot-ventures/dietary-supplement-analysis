# Changelog

## 0.13.0 (2026-10-19)

- **Five more herbs with NIH warnings:** garlic, Asian ginseng, saw palmetto, milk thistle and licorice root, each from its NIH NCCIH fact sheet (21 herbs and non-nutrients in all).
  - Garlic supplements may raise bleeding risk, and are paired with anticoagulants such as warfarin.
  - Asian ginseng may interfere with blood clotting, and is paired with diabetes medicines because it might lower blood sugar.
  - Licorice root's glycyrrhizin can cause irregular heartbeat, and it is paired with corticosteroids such as prednisone.
  - Milk thistle can cause allergic reactions in people allergic to ragweed and related plants.
  - Saw palmetto's pregnancy statement is relayed only for pregnancy or breastfeeding; its mild side effects are listed in `botanicals[]` but not in the summary.
  - Plain "ginseng" isn't matched, because it could be American or Siberian ginseng, which are different plants. DGL (deglycyrrhizinated) licorice is never reported as licorice, even when NIH files it under the licorice group.
  - Spanish summaries cover all five. The monthly fact-sheet check now watches their NCCIH pages too.
- Three new accuracy cases (59 in all): garlic with warfarin, Korean red ginseng with metformin, and DGL licorice (nothing reported).
- Dependency updates: fastify 5.12.7, eslint 10.13.0, typescript-eslint 8.71.2, vitest 5.0.5 and zod 4.6.7. Dependabot's grouped update had stalled.

## 0.12.7 (2026-10-11)

- **Agentic Portal relay route.** `POST /v1/tool` now runs `stack_analyze` when the body is just `{"arguments": {...}}`, the convention the Agentic Portal uses for its relay route, and accepts `"name"` (the MCP `tools/call` field) in place of `"tool"`. Existing calls are unchanged.

## 0.12.6 (2026-10-11)

- **Disclaimers and terms of use.** Every response's `disclaimer` now says the results are information only, not medical advice or a substitute for a doctor or pharmacist, not intended to diagnose, treat, cure or prevent any disease, and that labels and public data can be wrong; it gives US emergency and Poison Control numbers and links the new [terms of use](TERMS.md). The last sentence of `agent_summary` (English and Spanish) now tells the person to check with a doctor or pharmacist before changing anything. The agent guide, MCP instructions and OpenAPI description tell agents to relay this in full.
- **MIT License** for the code ([LICENSE](LICENSE)).
- **Agent-to-agent examples** ([examples/](examples/README.md)) and a daily check that every documented command works as written ([docs-check](.github/workflows/docs-check.yml)).

## 0.12.5 (2026-10-11)

- FDA summary: "1 FDA adverse event report names a product" (was "name").
- README: the judges' section is now real questions with the live answers, plus why the service matters for Pocket Network; Dependabot opens minor and patch updates only.

## 0.12.4 (2026-10-11)

- The repository moved to the Chariot Ventures GitHub account: [chariot-ventures/dietary-supplement-analysis](https://github.com/chariot-ventures/dietary-supplement-analysis). Every link (card, docs, provenance, free-trial message, auto-deploy, images at `ghcr.io/chariot-ventures/dietary-supplement-analysis`) points there; old links redirect. The official MCP Registry name is now `io.github.chariot-ventures/dietary-supplement-analysis`.

## 0.12.3 (2026-10-11)

- Fix: a version find-and-replace in 0.12.1 turned the eslint range into `^10.12.1`, which doesn't exist, and `npm ci` looped instead of failing. That stalled CI and the server's 0.12.1 and 0.12.2 builds; the service stayed on 0.12.0 throughout.
  - Restored the correct range.
  - A test now checks that package.json and the lockfile agree.
  - CI jobs time out after 15 minutes.
  - `npm run bump` edits only the version fields.

## 0.12.2 (2026-10-11)

- **Live check** every 30 minutes from GitHub: 16 end-to-end checks of the public service (`npm run live-check`). Once a day it also runs the Pocket portal audit and compares the on-chain card with `card/card.json`. Failures open an issue that closes itself on recovery.
- **Dependabot** for npm (weekly) and GitHub Actions (monthly).
- **`npm run bump`** sets the version in every file and opens a CHANGELOG entry.
- **Server upkeep:** the auto-deploy prunes Docker build cache, and kernel security updates reboot at 09:00 UTC (everything restarts by itself).

## 0.12.1 (2026-10-11)

- Compact answers no longer repeat the brand in product names ("Centrum Centrum Silver...").

## 0.12.0 (2026-10-11)

- **NIH DSLD mirrored.** The full DSLD download (214,782 labels, NIH's January 2026 edition) is imported into the label store and refreshed weekly when NIH publishes a new one (`deploy/mirror/dsld-mirror.sh`, `src/tools/import-dsld.ts`).
  - Labels and barcodes in the mirror are answered without calling NIH.
  - Name searches stay live and fall back to the mirror. After a 429 from NIH, they use the mirror first for 10 minutes.
  - `/v1/provenance` reports the mirrored version.
- **The background warmer no longer reruns on every deploy.** It runs at most once a day, and not at all once the mirror is present. It was the cause of today's NIH rate limiting.
- **api.data.gov key** support: the deployed compose file reads `settings.env` (DSLD and openFDA keys).
- **Free-trial burst limit:** at most 20 tool calls a minute per MCP connection, with its own readable message.
- **Monthly NIH fact-sheet check** ([.github/workflows/factsheets.yml](.github/workflows/factsheets.yml)): opens an issue when a cited ODS or NCCIH page is updated after our last review.

## 0.11.1 (2026-10-11)

- The free trial reads the client address from the last X-Forwarded-For entry (the one the proxy adds), so a caller-supplied header cannot reset a quota.

## 0.11.0 (2026-10-11)

- **Free trial on the demo host, paid route unchanged.** `agents.trackmysupplement.com` (REST and `/mcp`) now has daily quotas that reset at 00:00 UTC: 25 tool calls per MCP connection, 100 REST calls per IP, 1,000 MCP calls per IP, and 5,000 free calls in total. Discovery calls are free, and results are never degraded.
  - Callers see how many calls they have left (`X-Free-Tier-*` headers, MCP `_meta.free_tier`).
  - Past a quota, the reply is a readable message with the reset time and the Pocket Network route: `429 RATE_LIMITED` for REST, a tool result for MCP.
  - Relays through Pocket are never metered.
  - Counters persist across redeploys as salted hashes, kept for two days.
  - `/mcp` now gives each connection an `Mcp-Session-Id` and accepts `DELETE`.

## 0.10.0 (2026-10-11)

- **Real foods.** `foods` on `/v1/stack/analyze` takes what the person eats ("1 cup cooked spinach", "488 g whole milk") and matches it offline against the 8,789 foods of USDA SR28 (FoodData Central's SR Legacy), with USDA household portions. The foods are added to the supplement totals in `with_foods`, and food-only nutrients are checked too. Example: Brazil nuts alone can put selenium over its UL, and beef liver can do the same for vitamin A. Food counts toward a UL only where that UL covers food. Missing USDA analyses are listed rather than treated as zero, and three corrupt SR28 manganese values are excluded and reported. The table is built from the unchanged USDA files by `npm run build:foods` (checksums verified) and checked in `npm run check`.
- **Timing.** `timing` gives the NIH statements on when to take things that apply to the stack (calcium in doses of 500 mg or less, calcium carbonate with a meal, calcium and iron apart, iron 25 mg+ apart from zinc, iron with food at high doses, vitamin D with some fat, green tea extract with food, medication spacing), each with its products and fact sheet, in English and Spanish. The first tip is in `agent_summary`.
- 3 more accuracy cases (foods); 56 in all.

## 0.9.0 (2026-10-11)

- **Spanish summaries.** `"lang": "es"` on `/v1/stack/analyze` writes `agent_summary` in Spanish (English kept in `agent_summary_en`), covering limits, fixes, candidates, interactions, conditions and botanicals. All 251 NIH data phrases that can reach a summary have Spanish translations in [data/i18n-es.json](data/i18n-es.json), and a test fails if one is missing.
- **Spanish medication names.** Spanish generics and Spanish and Latin American brands (warfarina, acenocumarol/Sintrom, levotiroxina/Eutirox, omeprazol, metformina...) match, and accents are ignored ("fenitoína").
- Recall matching treats "vitamin" as a category word, so a notice for "Nature Made D3 1000IU" matches the product "Vitamin D3 1000 IU".

## 0.8.0 (2026-10-11)

- **Accuracy page.** [EVAL.md](EVAL.md): 53 supplement questions with answers worked out by hand from NIH tables ([eval/cases.json](eval/cases.json)); `npm run eval` scores the service (53/53, also enforced in the test suite) and `npm run eval:llm` compares a model alone against the same model with this service.
- **More suppliers.** CI ([.github/workflows/image.yml](.github/workflows/image.yml)) runs `npm run check` on every push and publishes a multi-arch image (amd64, arm64) to `ghcr.io/micallb/dietary-supplement-analysis` for every release. OPERATORS.md has a "run a supplier in 5 minutes" section, and [deploy/gateway-config.yaml](deploy/gateway-config.yaml) is the SAGE entry as a file.
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
