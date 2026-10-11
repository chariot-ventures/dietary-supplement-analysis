#!/usr/bin/env bash
# Agent-to-agent calls: other agents calling this service as one step of their own job.
# Each flow is what a different kind of agent sends, and what it gets back to act on.
#
#   bash examples/agent-flows.sh            # free demo endpoint (uses 5 of its 100 daily calls)
#   DSA_URL=https://your-gateway bash examples/agent-flows.sh
#
# Needs curl and jq.
set -euo pipefail
BASE=${DSA_URL:-https://agents.trackmysupplement.com}
post() { curl -sS "$BASE$1" -H 'Content-Type: application/json' -d "$2"; }
say() { printf '\n\033[1m%s\033[0m\n%s\n\n' "$1" "$2"; }

# The user's saved routine, as the calling agent stores it: names the user typed or bottles they scanned.
STACK='[{"query":"Centrum Silver Women 50+"},{"query":"Caltrate 600+D3"}]'

say "1. Pharmacy agent: a new prescription arrives" \
"A refill or e-prescribing agent gets a new levothyroxine prescription and checks it against the supplements on file before the patient picks it up."
post /v1/stack/analyze "{\"age\":66,\"sex\":\"female\",\"detail\":\"summary\",\"medications\":[\"levothyroxine\"],\"products\":$STACK}" |
  jq -r '.interactions.findings[] | select(.in_stack != false) | "- \(.trigger_name) + \(.nutrient_ids | join(", ")): \(.summary)\(if .timing then " Timing: \(.timing)" else "" end)"'

say "2. Shopping agent: checking the cart before checkout" \
"A retail or grocery agent sends the user's routine plus what's in the cart (by barcode or name) and gets a verdict per item."
post /v1/stack/analyze "{\"age\":66,\"sex\":\"female\",\"detail\":\"summary\",\"products\":$STACK,\"candidates\":[{\"upc\":\"031604026974\"},{\"query\":\"vitamin d3 5000 iu\"}]}" |
  jq -r '.candidate_results[] | "- [\(.verdict)] \(.text)"'

say "3. Vision agent: a label read from a photo" \
"A camera or OCR agent reads a bottle that isn't in the NIH database and passes the ingredients through as a custom product."
post /v1/stack/analyze '{"age":58,"sex":"male","detail":"summary","products":[{"query":"Centrum Silver Men 50+"},{"name":"Immune gummy (read from a photo)","servings_per_day":2,"ingredients":[{"name":"zinc","amount":15,"unit":"mg"},{"name":"vitamin C","amount":500,"unit":"mg"}]}]}' |
  jq -r '(.flagged[] | "- \(.name): \(.percent_of_ul)% of the upper limit (\(.ul_basis))"), (.suggestions[] | select(.resolves) | "- Fix: \(.text)")'

say "4. Health-coach agent: the weekly check" \
"A coaching or wearable agent reruns the full routine each week with typical food intake counted, and only messages the user when something is flagged."
post /v1/stack/analyze '{"age":62,"sex":"female","diet":"typical","detail":"summary","products":[{"query":"Centrum Silver Women 50+"},{"query":"KAL Magnesium Glycinate 400"},{"query":"Thompson Zinc 50 mg","servings_per_day":1}]}' |
  jq -r 'if (.flagged | length) == 0 then "- Nothing flagged this week; no message sent." else (.flagged[] | "- \(.name): \(.percent_of_ul)% of the UL from supplements, \(.with_typical_diet.percent_of_ul // "n/a")% with typical food"), (.suggestions[] | select(.resolves) | "- Suggest: \(.text)") end'

say "5. Medication-review agent: one step of a larger review" \
"An agent reviewing a patient's whole cabinet calls this service for the supplement side and other services for drug-drug checks (Pocket also carries med-safety and fda), then merges the results. No stack needed for this call."
post /v1/interactions/check '{"medications":["Synthroid","omeprazole"],"nutrients":["calcium","iron","magnesium","vitamin B12"]}' |
  jq -r '.findings[] | "- \(.trigger) (\(.trigger_name)) + \(.nutrient_ids | join(", ")): \(.summary)"'
