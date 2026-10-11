import { afterAll, describe, expect, it } from 'vitest';
import { testApp } from './helpers.js';

const app = testApp();
afterAll(() => app.close());
const rpc = (payload: unknown) => app.inject({ method: 'POST', url: '/mcp', payload: payload as Record<string, unknown> });

describe('remote MCP endpoint', () => {
  it('initializes, negotiating the protocol version', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    expect(res.json()).toMatchObject({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'dietary-supplement-analysis' } } });
    const unknown = await rpc({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    expect(unknown.json().result.protocolVersion).toBe('2025-06-18');
  });

  it('accepts notifications with 202 and no body', async () => {
    const res = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.statusCode).toBe(202);
    expect(res.body).toBe('');
  });

  it('lists the tools with JSON Schema inputs', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const tools = res.json().result.tools;
    expect(tools.map((t: { name: string }) => t.name)).toContain('stack_analyze');
    expect(tools[0].inputSchema.type).toBe('object');
  });

  it('calls stack_analyze (summary detail by default) and returns structured content', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'stack_analyze', arguments: { age: 62, sex: 'female', products: [{ query: 'zinc 50' }] } } });
    const result = res.json().result;
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ detail: 'summary', flagged: [{ nutrient_id: 'zinc' }] });
    expect(JSON.parse(result.content[0].text).agent_summary).toMatch(/Zinc/);
  });

  it('tool errors come back as isError results; unknown methods as JSON-RPC errors; batches work', async () => {
    const bad = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'stack_analyze', arguments: { products: [] } } });
    expect(bad.json().result).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_INPUT' } } });
    const missing = await rpc({ jsonrpc: '2.0', id: 6, method: 'sampling/createMessage' });
    expect(missing.json().error.code).toBe(-32601);
    const batch = await rpc([{ jsonrpc: '2.0', id: 7, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }]);
    expect(batch.json()).toEqual([{ jsonrpc: '2.0', id: 7, result: {} }]);
    expect((await app.inject({ method: 'GET', url: '/mcp' })).statusCode).toBe(405);
  });
});
