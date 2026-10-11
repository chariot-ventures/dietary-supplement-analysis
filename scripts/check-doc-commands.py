#!/usr/bin/env python3
"""
Run every copy-paste command the docs give judges and agent builders, exactly as
written, against the live demo endpoint, and report which ones work.

Covers the ```bash blocks in README.md and mcp/README.md that call the demo
endpoint, the curl lines in the hackathon form text (deploy/SUBMISSION.md), and
examples/agent-flows.sh. A command fails when it exits non-zero, prints nothing,
prints "null", or the service answers with an error object.

    python3 scripts/check-doc-commands.py          # needs bash, curl and jq
    python3 scripts/check-doc-commands.py --list   # show the commands without running them

It paces itself (about 20 calls a minute) to stay inside the demo's free-trial
limits, and uses roughly 25 of the 100 calls a day the demo allows one address.
"""
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEMO = "agents.trackmysupplement.com"
SKIP = ("pocket-ap", "localhost", "npm ", "docker ", "pip ", "python ")


def blocks(path: Path):
    """Fenced bash blocks that call the demo endpoint: (line number, command)."""
    text = path.read_text()
    for m in re.finditer(r"```bash\n(.*?)```", text, re.S):
        body = m.group(1).strip()
        if DEMO in body and not any(s in body for s in SKIP):
            yield text[: m.start()].count("\n") + 2, body


def form_lines(path: Path):
    """Single-line curl commands inside the form text block of SUBMISSION.md."""
    text = path.read_text()
    m = re.search(r"```text\n(.*?)```", text, re.S)
    if not m:
        return
    start = text[: m.start()].count("\n") + 2
    for i, line in enumerate(m.group(1).splitlines()):
        if line.startswith("curl ") and DEMO in line:
            yield start + i, line


def commands():
    for f in ("README.md", "mcp/README.md"):
        for line, cmd in blocks(ROOT / f):
            yield f"{f}:{line}", cmd
    for line, cmd in form_lines(ROOT / "deploy/SUBMISSION.md"):
        yield f"deploy/SUBMISSION.md:{line}", cmd
    yield "examples/agent-flows.sh", f"bash {ROOT / 'examples/agent-flows.sh'}"


def problem(code: int, out: str, err: str) -> "str | None":
    if code != 0:
        return f"exit {code}: {(err or out).strip()[:200]}"
    if not out.strip():
        return "no output"
    if re.search(r"(^|\n)null(\n|$)", out):
        return "printed null (a field the docs name is missing)"
    if '"error"' in out and '"code"' in out:
        return f"service error: {out.strip()[:200]}"
    return None


def main() -> int:
    cmds = list(commands())
    if "--list" in sys.argv:
        for where, cmd in cmds:
            print(f"## {where}\n{cmd}\n")
        return 0
    failed = 0
    print(f"# Doc commands: {len(cmds)} checked against https://{DEMO}\n")
    for n, (where, cmd) in enumerate(cmds):
        if n:
            time.sleep(3)
        r = subprocess.run(["bash", "-o", "pipefail", "-c", cmd], capture_output=True, text=True, timeout=120)
        p = problem(r.returncode, r.stdout, r.stderr)
        first = next((l for l in r.stdout.splitlines() if l.strip()), "")[:160]
        if p:
            failed += 1
            print(f"- FAIL {where}: {p}")
        else:
            print(f"- ok   {where}: {first}")
    print(f"\n{len(cmds) - failed} of {len(cmds)} commands work as written.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
