# Hackathon submission

Fields for the [Pocket Network Agentic Services Hackathon form](https://docs.google.com/forms/d/e/1FAIpQLScOgCt7oZhIGWgvMNBNxxmK-6W_7wTJbpzAvI-_KxqEk52BIw/viewform), as entered on 2026-10-11. The "How should judges test" field holds a shorter version of the commands below.

| Field | Value |
|---|---|
| Service Name | Dietary Supplement Label and Nutrient Intake Analysis |
| Testnet Service ID | `dietary-supplement-analysis` |
| Endpoint URL | `https://pokt-beta.trackmysupplement.com` (staked supplier, REST) |
| Test Transaction ID | `F3D81B3F797F86830CE1ACDBFBEA473EE989D4816093179A082BB423D9C788EB` (claim for the first paid relay, block 722793; settled at block 722813) |
| Repository Link | https://github.com/chariot-ventures/dietary-supplement-analysis |
| Category | Data service |

## Service description

60% of US adults take dietary supplements and 39% take two or more (CDC), and assistants are constantly asked "is my routine OK?". This service answers it with official data. The agent sends the products the way the user names them (product names, barcodes or NIH label IDs) with age and sex, plus any medications, conditions or foods. The service finds each label in the NIH Dietary Supplement Label Database (214,782 labels, mirrored weekly), totals every vitamin and mineral per day, and checks the totals against NIH upper limits and recommended intakes, including pregnancy, lactation and children. It checks medications (brand or generic, normalized with NIH RxNorm) against the interactions in the NIH fact sheets, flags herbs with NIH safety signals, and looks up FDA recalls and adverse event reports. It returns a plain-language summary the agent can relay, in English or Spanish, the one change that would fix an excess, and the effect of adding a product the user is considering, with every number traced to its label or NIH source. It complements Pocket's drug services (fda, med-safety) with the supplements those same users take, and every question sent through Pocket is a paid relay. It passes all 9 Pocket portal audit rules on Beta TestNet. Accuracy is checked against 56 hand-worked cases on every release.

## How judges can test it

As entered in the form:

```text
It's a REST service on Pocket Network Beta TestNet: service ID dietary-supplement-analysis, rpc_type REST, 500 compute units per relay, served by a staked supplier at https://pokt-beta.trackmysupplement.com. It passes all 9 Pocket portal audit rules (A1-A9), and the test transaction above is the settled claim for a paid relay. The exact request in A below was relayed again on 2026-10-11 against the current version (0.12.6), and its claim settled too: A9A5B3849C032011799A6CD966E7BC22135B78125495862577C3A156A9EC3DA5 (block 724433). Audit: https://mcp.pocketmcp.network/api/audit?network=beta&ids=dietary-supplement-analysis

A. Through Pocket Network, the way paying agents call it. With an application staked for dietary-supplement-analysis on Beta, relay with pocket-ap and the client config in the repo (deploy/beta-stake/pocket-ap.yaml):
POCKET_APP_PRIVATE_KEY=<app key hex> pocket-ap call --config deploy/beta-stake/pocket-ap.yaml --service dietary-supplement-analysis --rpc-type rest -X POST --path /v1/stack/analyze -d '{"age":74,"sex":"female","detail":"summary","medications":["Coumadin"],"products":[{"query":"Centrum Silver Women 50+"},{"query":"Nature Made Fish Oil 1200 mg"},{"query":"Ginkgo Biloba 120 mg"}]}' -v
The same paths and request bodies work for every example below; only the transport changes.

B. Without staking: the demo endpoint https://agents.trackmysupplement.com runs the same backend as the supplier without the relay layer, so plain curl works (rate-limited: 30 requests a minute and 100 a day per client). Each example is one call, the way an agent makes it after a user describes their routine; jq -r .agent_summary prints the answer it would relay. The README section "For judges: try it in one minute" shows the live answers.

1. "I'm 74 and on Coumadin. I take Centrum Silver, fish oil and ginkgo." (brand drug name, products by name, ginkgo + warfarin bleeding risk, vitamin K vs warfarin, fish oil and INR)
curl -s https://agents.trackmysupplement.com/v1/stack/analyze -H 'Content-Type: application/json' -d '{"age":74,"sex":"female","detail":"summary","medications":["Coumadin"],"products":[{"query":"Centrum Silver Women 50+"},{"query":"Nature Made Fish Oil 1200 mg"},{"query":"Ginkgo Biloba 120 mg"}]}' | jq -r .agent_summary

2. "I'm pregnant. I take a prenatal, vitamin A 25,000 IU and ashwagandha." (vitamin A at 250% of the pregnancy limit, which guards against birth defects; NIH says avoid ashwagandha in pregnancy)
curl -s https://agents.trackmysupplement.com/v1/stack/analyze -H 'Content-Type: application/json' -d '{"age":29,"sex":"female","life_stage":"pregnancy","detail":"summary","products":[{"query":"Nature Made Prenatal Multi + DHA"},{"query":"vitamin A 25000 IU"},{"query":"ashwagandha root extract"}]}' | jq -r .agent_summary

3. "I'm 62: Centrum Silver, fish oil, magnesium and zinc. Should I add vitamin D 5000?" (zinc at 163% of the limit, the one change that fixes it, and the what-if for vitamin D, with typical food intake counted)
curl -s https://agents.trackmysupplement.com/v1/stack/analyze -H 'Content-Type: application/json' -d '{"age":62,"sex":"female","diet":"typical","products":[{"query":"Centrum Silver Women 50+"},{"query":"Nature Made Ultra Fish Oil 1400"},{"query":"KAL Magnesium Glycinate 400"},{"query":"Thompson Zinc 50 mg","servings_per_day":1}],"candidates":[{"query":"vitamin d3 5000 iu"}]}' | jq -r .agent_summary

4. In Spanish, with Spanish drug names (warfarina, levotiroxina):
curl -s https://agents.trackmysupplement.com/v1/stack/analyze -H 'Content-Type: application/json' -d '{"age":68,"sex":"female","lang":"es","detail":"summary","medications":["warfarina","levotiroxina"],"products":[{"query":"Centrum Silver Women 50+"},{"query":"Caltrate 600+D3"}]}' | jq -r .agent_summary

5. FDA recalls and adverse event reports for a product:
curl -s https://agents.trackmysupplement.com/v1/products/fda -H 'Content-Type: application/json' -d '{"query":"Nature Made Vitamin D3 1000 IU"}' | jq -r .agent_summary

C. Agent to agent, where much of the relay volume should come from: examples/agent-flows.sh in the repo runs five calls other agents make with no person in the loop. A pharmacy agent checks a new levothyroxine prescription against the supplements on file, a shopping agent gets a verdict for each item in a cart, a vision agent passes along a label it read from a photo, a health-coach agent runs its weekly check, and a medication-review agent combines this service with drug-drug services such as Pocket's med-safety. examples/agent_loop.py is a 50-line assistant that loads GET /v1/tools and lets a model call them. The pharmacy agent's call:
curl -s https://agents.trackmysupplement.com/v1/stack/analyze -H 'Content-Type: application/json' -d '{"age":66,"sex":"female","detail":"summary","medications":["levothyroxine"],"products":[{"query":"Centrum Silver Women 50+"},{"query":"Caltrate 600+D3"}]}' | jq '.interactions.findings[] | {trigger_name, nutrient_ids, summary, timing}'

Every response is a JSON object, errors are 4xx (never 5xx), and GET /openapi.json and GET /v1/tools describe every operation. The README's "Why it matters for Pocket Network" section covers demand and repeat relays.

Tested as documented: a daily GitHub workflow runs every curl command in this form and the README exactly as written against the live endpoint (all 12 checks pass, including the five agent flows), and examples/agent_loop.py (a model calling the service's tools) was tested end to end with a real model. Every response says it is information, not medical advice, and links the terms of use (TERMS.md). The code is MIT licensed.
```
