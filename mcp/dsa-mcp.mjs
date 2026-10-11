#!/usr/bin/env node
/* global process, fetch, AbortSignal */
/**
 * dietary-supplement-analysis as a local MCP server (stdio), with no dependencies.
 *
 * It exposes the service's tools to any MCP client and forwards each call to the
 * service's REST API. Point it at:
 *   - the public demo endpoint (default):       DSA_BASE_URL=https://agents.trackmysupplement.com
 *   - Pocket Network, paid per relay, through a local pocket-ap listener:
 *       pocket-ap serve --config deploy/beta-stake/pocket-ap.yaml   (with POCKET_APP_PRIVATE_KEY set)
 *       DSA_BASE_URL=http://127.0.0.1:8550
 *
 * Claude Desktop config (claude_desktop_config.json):
 *   { "mcpServers": { "supplements": { "command": "node", "args": ["/path/to/dsa-mcp.mjs"],
 *                                       "env": { "DSA_BASE_URL": "http://127.0.0.1:8550" } } } }
 *
 * Clients that support remote MCP servers can use https://agents.trackmysupplement.com/mcp directly instead.
 * Requires Node 18+ (global fetch).
 */
import { createInterface } from 'node:readline';

const BASE = (process.env.DSA_BASE_URL || 'https://agents.trackmysupplement.com').replace(/\/+$/, '');
const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
let tools = null;

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const log = (...a) => process.stderr.write(`[dsa-mcp] ${a.join(' ')}\n`);

async function http(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { error: { code: 'BAD_RESPONSE', message: `HTTP ${res.status}: ${text.slice(0, 200)}` } };
  }
  return { ok: res.ok, json };
}

async function loadTools() {
  if (tools) return tools;
  const { ok, json } = await http('GET', '/v1/tools');
  if (!ok || !Array.isArray(json.tools)) throw new Error(`could not load tools from ${BASE}/v1/tools`);
  tools = json.tools;
  return tools;
}

async function handle(msg) {
  const id = msg.id ?? null;
  const params = msg.params ?? {};
  switch (msg.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'dietary-supplement-analysis', version: '1.0.0' },
          instructions: 'Use stack_analyze for whether a set of supplements is too much or what to change; pass products as the user names them, with age and sex. Relay agent_summary. Not medical advice.',
        },
      };
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list': {
      const list = await loadTools();
      return { jsonrpc: '2.0', id, result: { tools: list.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })) } };
    }
    case 'tools/call': {
      const list = await loadTools();
      const tool = list.find((t) => t.name === params.name);
      if (!tool) return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: `Unknown tool ${params.name}` }] } };
      const args = { ...(params.arguments ?? {}) };
      if (tool.name === 'stack_analyze' && args.detail === undefined) args.detail = 'summary';
      try {
        const { ok, json } = await http('POST', tool.path, args);
        return { jsonrpc: '2.0', id, result: { isError: !ok, content: [{ type: 'text', text: JSON.stringify(json) }], structuredContent: json } };
      } catch (err) {
        return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: `Request to ${BASE} failed: ${err.message}` }] } };
      }
    }
    default:
      if (typeof msg.method === 'string' && msg.method.startsWith('notifications/')) return null;
      return msg.id === undefined ? null : { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  try {
    const out = await handle(msg);
    if (out) send(out);
  } catch (err) {
    log(err.message);
    if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: err.message } });
  }
});
log(`forwarding to ${BASE}`);
