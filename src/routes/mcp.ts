/**
 * Remote MCP server (Streamable HTTP transport, stateless, JSON responses).
 *
 *   claude.ai / Claude Desktop "custom connector":  https://agents.trackmysupplement.com/mcp
 *
 * POST /mcp takes one JSON-RPC 2.0 message or a batch. Supported methods:
 * initialize, notifications/*, ping, tools/list, tools/call. There is no
 * server-to-client stream (GET /mcp answers 405), so no session is kept.
 *
 * This route speaks JSON-RPC, so it is meant for direct use, not for Pocket
 * relays (the REST routes are the relay contract). stack_analyze defaults to
 * "detail": "summary" here, because MCP results go straight into a model's
 * context window.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { AppError } from '../lib/errors.js';
import { GUIDE } from '../lib/guide.js';
import { SERVICE_ID, VERSION } from '../version.js';
import type { Deps } from './deps.js';
import { nutrientReference } from './nutrients.js';
import { getProducts, lookupProduct, searchProducts } from './products.js';
import { checkInteractions } from './interactions.js';
import { analyze } from './stack.js';
import { toolDefinitions } from './tools.js';

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

type Id = string | number | null;
interface RpcRequest {
  jsonrpc?: unknown;
  id?: Id;
  method?: unknown;
  params?: unknown;
}

const rpcError = (id: Id, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
const rpcResult = (id: Id, result: unknown) => ({ jsonrpc: '2.0', id, result });

const INSTRUCTIONS =
  'Use stack_analyze for any question about whether a set of dietary supplements is too much, overlaps, or what to change. Pass products the way the user names them ({"query": "..."}), with age and sex, plus any medications and conditions the user mentions. Relay agent_summary; do not call a stack "safe". ' +
  'interactions_check lists NIH-documented medication interactions without a stack; products_lookup takes a barcode; nutrients_reference gives RDA/UL for one nutrient. Label and reference data only, not medical advice.';

async function callTool(name: string, args: Record<string, unknown>, deps: Deps): Promise<unknown> {
  switch (name) {
    case 'stack_analyze':
      return analyze({ detail: 'summary', ...args }, deps);
    case 'products_search':
      return searchProducts(args, deps);
    case 'products_lookup':
      return lookupProduct(args, deps);
    case 'products_get':
      return getProducts(args, deps);
    case 'nutrients_reference':
      return nutrientReference(args);
    case 'interactions_check':
      return checkInteractions(args, deps);
    default:
      throw new AppError('NOT_FOUND', `Unknown tool "${name}"`, { field: 'name' });
  }
}

async function handle(msg: RpcRequest, deps: Deps): Promise<object | null> {
  const id: Id = msg.id ?? null;
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(id, -32600, 'Invalid Request');
  const isNotification = msg.id === undefined;
  const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Record<string, unknown>;

  switch (msg.method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return rpcResult(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVICE_ID, title: 'Dietary Supplement Analysis (NIH data)', version: VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return isNotification ? null : rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, {
        tools: toolDefinitions().map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema, annotations: { readOnlyHint: true, openWorldHint: true } })),
      });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {}) as Record<string, unknown>;
      try {
        const result = await callTool(name, args, deps);
        return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false });
      } catch (err) {
        // Tool failures are results the model can read and act on, not protocol errors.
        const body = err instanceof AppError ? err.toBody() : new AppError('INTERNAL_ERROR', 'The request could not be processed').toBody();
        return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body, isError: true });
      }
    }
    case 'resources/list':
      return rpcResult(id, { resources: [{ uri: 'guide://usage', name: 'Usage guide', mimeType: 'text/markdown' }] });
    case 'resources/read':
      return rpcResult(id, { contents: [{ uri: 'guide://usage', mimeType: 'text/markdown', text: GUIDE }] });
    default:
      if (msg.method.startsWith('notifications/')) return null;
      return isNotification ? null : rpcError(id, -32601, `Method not found: ${msg.method}`);
  }
}

export function registerMcpRoute(app: FastifyInstance, deps: Deps): void {
  app.post('/mcp', async (req, reply: FastifyReply) => {
    const body = req.body as unknown;
    if (body === undefined || body === null || typeof body !== 'object') return reply.code(400).send(rpcError(null, -32700, 'Parse error'));
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => handle(m as RpcRequest, deps)))).filter((r) => r !== null);
      return out.length ? reply.send(out) : reply.code(202).send();
    }
    const out = await handle(body as RpcRequest, deps);
    return out ? reply.send(out) : reply.code(202).send();
  });
  // No server-initiated stream: clients fall back to plain request/response.
  app.get('/mcp', async (_req, reply) => reply.code(405).header('allow', 'POST').send({ error: { code: 'INVALID_INPUT', message: 'This MCP endpoint accepts POST only (stateless, JSON responses).', retryable: false } }));
}
