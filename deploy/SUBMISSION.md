# Hackathon submission (draft)

Fields for the Pocket Network Agentic Services Hackathon form (PLAN.md section 11). Check the live examples before submitting.

| Field | Value |
|---|---|
| Service Name | Dietary Supplement Label and Nutrient Intake Analysis |
| Testnet Service ID | `dietary-supplement-analysis` |
| Endpoint URL | `https://pokt-beta.trackmysupplement.com` (staked supplier, REST) |
| Test Transaction ID | `F3D81B3F797F86830CE1ACDBFBEA473EE989D4816093179A082BB423D9C788EB` (claim for the first paid relay, block 722793; settled at block 722813) |
| Repository Link | https://github.com/micallb/dietary-supplement-analysis |
| Category | Data service |

## Service description

Agents ask one question for people who take supplements: is anything I take too much, and what should I change? Send the products the way the user names them (product names, barcodes or NIH label IDs) with age and sex. The service finds each label in the NIH Dietary Supplement Label Database, totals every vitamin and mineral per day, and checks the totals against NIH upper limits and recommended intakes, including pregnancy, lactation, infants and an optional typical-diet estimate. It returns a plain-language summary an agent can relay, what each upper limit protects against, the single change that would fix an excess, and the effect of adding a product the user is considering, with every number traced to its label or NIH fact sheet.

## How judges can test it

The demo endpoint runs the same backend without the relay layer, so plain `curl` works (30 requests a minute per client):

```bash
# 1. One call, products named the way a user would, with a what-if candidate and typical food intake
curl -s https://agents.trackmysupplement.com/v1/stack/analyze -H 'Content-Type: application/json' -d '{
  "age": 62, "sex": "female", "diet": "typical",
  "products": [
    {"query": "Centrum Silver Women 50+"},
    {"query": "Nature Made Ultra Fish Oil 1400"},
    {"query": "KAL Magnesium Glycinate 400"},
    {"query": "Thompson Zinc 50 mg", "servings_per_day": 1}],
  "candidates": [{"query": "vitamin d3 5000 iu"}]}' | jq '.agent_summary, .suggestions[0].text'

# 2. Barcode lookup
curl -s https://agents.trackmysupplement.com/v1/products/lookup -H 'Content-Type: application/json' -d '{"upc":"031604026974"}' | jq '.product.name'

# 3. Reference values (offline), including pregnancy
curl -s https://agents.trackmysupplement.com/v1/nutrients/reference -H 'Content-Type: application/json' -d '{"nutrient":"folate","age":30,"sex":"female","life_stage":"pregnancy"}'

# 4. Tool definitions for agent frameworks
curl -s https://agents.trackmysupplement.com/v1/tools | jq '.tools[].name'
```

Through Pocket Network: stake an application for `dietary-supplement-analysis` on Beta TestNet and relay with `pocket-ap` (README, "Through Pocket Network").
