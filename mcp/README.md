# Using the service from MCP clients

## Remote (no install)

Add this URL as a custom connector or remote MCP server (Claude, claude.ai, Cursor, and other clients that support Streamable HTTP):

```
https://agents.trackmysupplement.com/mcp
```

It exposes `stack_analyze`, `interactions_check`, `products_fda_reports`, `products_search`, `products_lookup`, `products_get` and `nutrients_reference`. `stack_analyze` returns the compact `"detail": "summary"` form by default, because MCP results go straight into the model's context; pass `"detail": "full"` for every field.

This remote endpoint is a **free trial**: 25 tool calls per connection per day (plenty for one person), with a per-address and an overall daily cap behind it. Each result's `_meta.free_tier` shows what's left. When a quota is used up, the tool returns a plain message with the reset time (00:00 UTC) and the paid route. For regular or automated use, run it through Pocket Network as below; that route has no quotas.

## Local, paid through Pocket Network

[`dsa-mcp.mjs`](dsa-mcp.mjs) is a single-file stdio MCP server (Node 18+, no dependencies) that forwards tool calls to the REST API. Run Pocket's `pocket-ap` as a local relay listener and point the bridge at it, so every call is a signed, paid Pocket relay:

```bash
export POCKET_APP_PRIVATE_KEY=<your staked app key>          # an app staked for dietary-supplement-analysis on Beta
pocket-ap serve --config deploy/beta-stake/pocket-ap.yaml     # listens on 127.0.0.1:8550
curl -fsSL https://raw.githubusercontent.com/micallb/dietary-supplement-analysis/release/mcp/dsa-mcp.mjs -o dsa-mcp.mjs
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "supplements": {
      "command": "node",
      "args": ["/absolute/path/to/dsa-mcp.mjs"],
      "env": { "DSA_BASE_URL": "http://127.0.0.1:8550" }
    }
  }
}
```

Without `DSA_BASE_URL` the bridge uses the public demo endpoint.

## Registries

[`server.json`](server.json) is the entry for the official MCP Registry. Publish it with `mcp-publisher login github` and `mcp-publisher publish` from this folder. The `io.github.micallb/` name needs the repository owner's GitHub login. The same URL can be submitted to Smithery and mcp.so through their web forms.
