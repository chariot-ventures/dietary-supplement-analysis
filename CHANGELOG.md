# Changelog

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
