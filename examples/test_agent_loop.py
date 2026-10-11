"""
Offline-model test of agent_loop.py: runs it against the live service with a stand-in
for the Anthropic client, so everything except the model itself is exercised.

    python3 examples/test_agent_loop.py

The stand-in checks that every tool definition is one the Messages API accepts
(only name, description and input_schema; a valid name; an object schema), then
asks for one stack_analyze call the way a model would. It checks that the loop
sends back a tool_result carrying the service's answer, and ends the conversation
with that answer. Run agent_loop.py itself with ANTHROPIC_API_KEY for the real model.
"""
import runpy
import sys
import tempfile
import textwrap
from pathlib import Path

FAKE = textwrap.dedent('''
    import json, re, sys
    from types import SimpleNamespace as NS

    CALL = {"age": 66, "sex": "female", "detail": "summary", "medications": ["Synthroid"],
            "products": [{"query": "Centrum Silver Women 50+"}, {"query": "Caltrate 600+D3"}]}
    checks = []

    class Messages:
        def __init__(self):
            self.turn = 0
        def create(self, model, max_tokens, tools, messages, system=None):
            self.turn += 1
            if self.turn == 1:
                for t in tools:
                    assert set(t) == {"name", "description", "input_schema"}, f"extra keys in {t.get('name')}: {set(t)}"
                    assert re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", t["name"]), t["name"]
                    assert t["input_schema"].get("type") == "object", t["name"]
                    assert t["description"].strip(), t["name"]
                checks.append(f"{len(tools)} tool definitions accepted: " + ", ".join(t["name"] for t in tools))
                return NS(usage=NS(input_tokens=0, output_tokens=0), content=[NS(type="text", text="Checking."), NS(type="tool_use", id="toolu_test_1", name="stack_analyze", input=CALL)])
            last = messages[-1]
            assert last["role"] == "user", last
            result = last["content"][0]
            assert result["type"] == "tool_result" and result["tool_use_id"] == "toolu_test_1", result
            assert not result["is_error"], result["content"][:300]
            body = json.loads(result["content"])
            summary = body["agent_summary"]
            assert "levothyroxine" in summary.lower() or "synthroid" in summary.lower(), summary
            checks.append("tool_result carried the service answer (" + str(len(result["content"])) + " bytes)")
            return NS(usage=NS(input_tokens=0, output_tokens=0), content=[NS(type="text", text="MODEL ANSWER: " + summary)])

    class Anthropic:
        def __init__(self, *a, **k):
            self.messages = Messages()
''')


def main() -> int:
    here = Path(__file__).resolve().parent
    with tempfile.TemporaryDirectory() as d:
        Path(d, "anthropic.py").write_text(FAKE)
        sys.path.insert(0, d)
        sys.argv = ["agent_loop.py", "I'm 66, on Synthroid, and take Centrum Silver and Caltrate. Anything I should know?"]
        from io import StringIO
        out, real = StringIO(), sys.stdout
        sys.stdout = out
        try:
            runpy.run_path(str(here / "agent_loop.py"), run_name="__main__")
        finally:
            sys.stdout = real
        import anthropic  # the stand-in, now loaded
    printed = out.getvalue()
    for c in anthropic.checks:
        print("ok  ", c)
    if "MODEL ANSWER:" not in printed:
        print("FAIL the loop did not print the final answer")
        return 1
    print("ok   the loop printed the final answer and stopped")
    print("\n" + printed.strip()[:600])
    return 0


if __name__ == "__main__":
    sys.exit(main())
