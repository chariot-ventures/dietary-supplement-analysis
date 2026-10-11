"""Give /mcp on the demo host its own per-IP flood guard (300/min) and keep REST at 30/min.

MCP clients such as claude.ai share a few egress IPs, so a per-IP limit sized for one
developer would block many people at once; the backend enforces the per-connection
limits (20 a minute, 25 a day). Usage (on the server):
    python3 split-mcp-zone.py /opt/pocket/caddy/Caddyfile > Caddyfile.new
Idempotent: a Caddyfile that already has the mcp zone is printed unchanged.
"""
import sys

OLD = """\t\tzone per_client {
\t\t\tkey {remote_host}
\t\t\tevents 30
\t\t\twindow 1m
\t\t}
"""
NEW = """\t\tzone per_client {
\t\t\tmatch {
\t\t\t\tnot path /mcp
\t\t\t}
\t\t\tkey {remote_host}
\t\t\tevents 30
\t\t\twindow 1m
\t\t}
\t\tzone per_client_mcp {
\t\t\tmatch {
\t\t\t\tpath /mcp
\t\t\t}
\t\t\tkey {remote_host}
\t\t\tevents 300
\t\t\twindow 1m
\t\t}
"""
text = open(sys.argv[1]).read()
if "per_client_mcp" not in text:
    if text.count(OLD) != 1:
        sys.exit("expected exactly one per_client zone; not changing anything")
    text = text.replace(OLD, NEW)
    text = text.replace("Demo endpoint limit reached (30 requests per minute per client).", "Demo endpoint rate limit reached.")
sys.stdout.write(text)
