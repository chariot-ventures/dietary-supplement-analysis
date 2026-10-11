"""
An assistant that answers supplement questions by calling this service as tools.

The service publishes its own tool definitions at GET /v1/tools (name, description
and a JSON Schema input_schema, the shape the Anthropic Messages API and most
function-calling APIs take), and runs any of them at POST /v1/tool. So the whole integration is: load the tools, pass them to
the model, and forward each tool call. Nothing here is specific to supplements.

    pip install anthropic requests
    export ANTHROPIC_API_KEY=...
    python examples/agent_loop.py "I'm 66, on Synthroid, and take Centrum Silver and Caltrate. Anything I should know?"

DSA_URL defaults to the free demo endpoint. Point it at a Pocket Network gateway
for paid relays. DSA_MODEL picks the model.
"""
import json
import os
import sys

import anthropic
import requests

BASE = os.environ.get("DSA_URL", "https://agents.trackmysupplement.com")
MODEL = os.environ.get("DSA_MODEL", "claude-sonnet-5-5")

# Each definition also carries its REST "path"; the Messages API takes only these three keys.
tools = [
    {k: t[k] for k in ("name", "description", "input_schema")}
    for t in requests.get(f"{BASE}/v1/tools", timeout=30).json()["tools"]
]
client = anthropic.Anthropic()
question = " ".join(sys.argv[1:]) or "I take Centrum Silver Women 50+ and Thompson Zinc 50 mg. I'm 62. Is that too much of anything?"
messages = [{"role": "user", "content": question}]

for _ in range(6):  # a few rounds of tool calls at most
    response = client.messages.create(
        model=MODEL,
        max_tokens=1500,
        system="Answer supplement questions using the dietary-supplement-analysis tools. Relay agent_summary faithfully, cite the sources it gives, and never say a routine is safe.",
        tools=tools,
        messages=messages,
    )
    messages.append({"role": "assistant", "content": response.content})
    calls = [b for b in response.content if b.type == "tool_use"]
    if not calls:
        print("".join(b.text for b in response.content if b.type == "text"))
        break
    results = []
    for call in calls:
        r = requests.post(f"{BASE}/v1/tool", json={"tool": call.name, "arguments": call.input}, timeout=60)
        print(f"[tool] {call.name} -> HTTP {r.status_code}", file=sys.stderr)
        results.append({"type": "tool_result", "tool_use_id": call.id, "content": json.dumps(r.json()), "is_error": r.status_code >= 400})
    messages.append({"role": "user", "content": results})
