/**
 * Agent-facing usage guide. Served at GET /v1/guide (inside a JSON object, per
 * the gateway rules) and written to llms.txt in the repository by
 * scripts/build-openapi.ts, so the two never drift.
 */
import { DOCS_URL, SERVICE_ID, VERSION } from '../version.js';

export const GUIDE = `# ${SERVICE_ID} ${VERSION}

> Supplement label lookup (NIH Dietary Supplement Label Database, DSLD) and per-nutrient intake checks against NIH reference values. One call answers "is anything in my supplements too high, why does that matter, and what change would fix it". Label and reference data only; not medical advice.

All endpoints take and return JSON objects. Errors are 4xx JSON: {"error":{"code","message","retryable","field"}}. Never 5xx.

## The one call most agents need

POST /v1/stack/analyze with what the user said, as written:

    {"age": 62, "sex": "female",
     "products": [
       {"query": "Centrum Silver Women 50+"},
       {"query": "Nature Made fish oil 1400"},
       {"upc": "031604026974"},
       {"dsld_id": 253226, "servings_per_day": 1},
       {"name": "Homemade zinc", "ingredients": [{"name": "zinc", "amount": 25, "unit": "mg"}]}
     ],
     "medications": ["warfarin", "Synthroid"],
     "conditions": ["smoker"],
     "candidates": [{"query": "vitamin d3 5000 iu"}]}

- products: 1-15. Each is a product name ({"query"}), a barcode ({"upc"}), a DSLD ID ({"dsld_id"}), or a custom product with explicit ingredients. Pass "servings_per_day" whenever the user said how much they take; otherwise the label's maximum daily servings is assumed (listed in assumptions).
- lang (optional): "es" writes agent_summary in Spanish (English kept in agent_summary_en). Medication names may be given in Spanish ("warfarina", "levotiroxina", "Sintrom").
- detail (optional): "summary" for a compact 1-3 KB answer (recommended when the result goes into your context); "full" (default) for every field.
- diet (optional): "typical" adds US average food and drink intake for the age and sex (NHANES) and repeats the checks in nutrient_totals[].with_typical_diet. Use it when the user asks whether their total intake is too high or too low.
- candidates (optional, up to 5): products the user is thinking of adding. Each is evaluated as an addition in candidate_results[].
- medications (optional, up to 30): generic or brand names as the user said them. Each is matched to a drug class (RxNorm normalizes names the list doesn't know) and checked against the medication interactions in the NIH ODS fact sheets and, for herbs in the stack (St. John's wort, ginkgo, kava...), the NIH NCCIH fact sheets, with timing advice where NIH gives it (for example, take levothyroxine 4 hours apart from calcium or iron). Not exhaustive.
- conditions (optional): smoker (current or former, or asbestos exposure), kidney_disease, hemochromatosis, lab_test_soon (biotin skews lab tests), cancer_treatment. Each flags the doses NIH warns about for that group.
- age and sex together enable upper-limit checks. Add "life_stage": "pregnancy" or "lactation" (female, 14-50) for those reference values. For infants, give age as a fraction of a year (0.25 = 3 months).

Read the response in this order:
1. agent_summary: two to five plain sentences you can relay as written.
2. resolutions[]: how each {query}/{upc} was identified, with confidence (high/medium/low) and alternatives. If confidence is low, confirm the product with the user and re-run with its dsld_id.
3. suggestions[]: single-product changes that would bring an above-UL nutrient to or under its UL (reduce servings or leave a product out), with the resulting amount, best first.
4. nutrient_totals[]: per nutrient: daily_total, amount_toward_ul, percent_of_ul, flags (above_ul, near_ul), severity (high: 2x UL or more, moderate: above UL, low: within 10% of UL), coverage (percent of RDA/AI from supplements alone, informational), reference.ul_basis (what the UL protects against), and contributions per product.
5. botanicals[] (when present): herbs and other non-nutrients in the stack with NIH NCCIH/ODS safety signals (liver injury, bleeding, drug interactions, banned ingredients) and dose checks (creatine, EGCG, valerian).
6. interactions (when medications or conditions were given): medications[] shows how each name was matched; findings[] lists every NIH-listed interaction, those involving a nutrient in the stack (in_stack: true) first.
7. data_gaps[]: what could not be counted, plus DATA_SUSPECT entries where the NIH label record looks inconsistent (duplicate row, nested amounts larger than the total, %DV that contradicts the amount, implausible amount).

## Other endpoints

- POST /v1/products/search {"query", "brand"?, "ingredient"?, "limit"<=10, "dedupe_versions"=true}: product summaries, one per product (older label versions in other_versions).
- POST /v1/products/lookup {"upc"}: the label for a barcode, newest version first.
- POST /v1/products/fda {"query"} or {"upc"} or {"dsld_id"} or {"brand", "name"}: FDA recalls matching the product and CAERS adverse event report counts (reports do not show causation).
- POST /v1/products/get {"dsld_id"} or {"dsld_ids": [...]}: full normalized labels.
- POST /v1/interactions/check {"medications"?, "conditions"?, "nutrients"?}: NIH-listed nutrient interactions for medications or conditions, without a stack.
- POST /v1/nutrients/reference {"nutrient", "age", "sex"}: RDA, EAR, AI, UL and UL basis. Offline.
- POST /v1/tool {"tool", "arguments"}: one dispatcher for all of the above.
- GET /v1/tools: tool definitions with JSON Schema inputs, ready for function calling.
- POST /mcp: the same tools as a remote MCP server (Streamable HTTP); stack_analyze defaults to detail "summary" there.
- GET /v1/provenance: code version, git commit and data editions behind every answer.
- GET /openapi.json: OpenAPI 3.1.

## Rules for relaying results

- The totals cover the listed supplements only, not food, drinks or medications.
- No flag means nothing to report for that nutrient; it is not a clean bill of health. Do not tell the user a stack is harmless.
- Medication interactions are checked only when medications are given, and only those named in the NIH fact sheets. No finding does not mean no interaction; suggest a pharmacist check. Supplement-to-supplement interactions are not assessed.
- Every number links to its DSLD label or NIH fact sheet in sources[].

Docs: ${DOCS_URL}
`;
