# Agent-to-agent examples

Many calls to this service won't come from a person typing a question but from other agents that handle supplements as one step of a bigger job: a pharmacy agent filling a prescription, a shopping agent checking a cart, a coaching agent doing a weekly review. Those agents call the service on every relevant event, without a person in the loop, so each one is a steady source of relays.

## Five agents, five calls

[`agent-flows.sh`](agent-flows.sh) runs all five against the free demo endpoint (`bash examples/agent-flows.sh`; needs `curl` and `jq`). Each is one HTTP call whose output the calling agent acts on directly.

| Calling agent | Event | Call | What it acts on |
|---|---|---|---|
| Pharmacy or e-prescribing agent | A new prescription (levothyroxine) for a patient with supplements on file | `POST /v1/stack/analyze` with `medications` | `interactions.findings[]`: calcium carbonate and iron in the stack, with NIH's 4-hour spacing in `timing` |
| Retail or grocery agent | The user's cart, before checkout | `stack/analyze` with the cart as `candidates` (barcodes or names) | `candidate_results[].verdict`: `adds_above_ul` for the vitamin D3 5000 IU, `no_new_flags` for the fish oil |
| Vision or OCR agent | A photo of a bottle that isn't in the NIH database | a custom product with the ingredients it read | `flagged[]` (zinc 113% of the UL) and the `suggestions[]` entry that fixes it |
| Health-coach or wearable agent | Its weekly schedule | `stack/analyze` with `"diet": "typical"` | `flagged[]` with and without food; it messages the user only when something is flagged |
| Medication-review agent | Reviewing a whole medicine cabinet | `POST /v1/interactions/check` (no stack needed) | NIH-listed supplement interactions for Synthroid and omeprazole, merged with drug-drug results from other services such as Pocket's `med-safety` and `fda` |

Every answer is a JSON object with machine-readable fields (`verdict`, `flags`, `severity`, `resolves`, `kind`, `timing`) for the calling agent, an `agent_summary` it can pass to a person as written, and a source for every statement.

## A model calling the tools itself

[`agent_loop.py`](agent_loop.py) is a complete assistant in about 50 lines. It loads the service's tool definitions from `GET /v1/tools`, gives them to the model, and forwards each tool call to `POST /v1/tool`. Nothing in it is specific to supplements, so the same loop works for any agent framework that takes JSON Schema tools.

```bash
pip install anthropic requests
export ANTHROPIC_API_KEY=...
python examples/agent_loop.py "I'm 66, on Synthroid, and take Centrum Silver and Caltrate. Anything I should know?"
```

MCP clients get the same tools from `https://agents.trackmysupplement.com/mcp`.

## Paying per call

Agents with real volume call the same paths through Pocket Network, with no API key and no account: each call is a relay paid from the agent's application stake, and the request and response are identical to the demo. See [Through Pocket Network](../README.md#through-pocket-network-paid-relay). The free demo endpoint allows 100 REST calls a day per address, and its rate-limit answers point agents to the paid route.
