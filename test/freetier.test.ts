import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { FreeTier, ipKey, openFreeTier } from '../src/lib/freetier.js';
import { fixtureClient } from './helpers.js';

const DEMO = 'agents.test';
let clock = new Date('2026-10-11T12:00:00Z');
const limits = { perSession: 2, perIpRest: 3, perIpMcp: 5, global: 8 };
const tier = new FreeTier([DEMO], limits, null, () => clock);
const app = buildApp({ dsld: fixtureClient(), freeTier: tier });
afterAll(() => app.close());

const ref = { nutrient: 'zinc', age: 40, sex: 'male' };
const rest = (ip: string, host = DEMO) => app.inject({ method: 'POST', url: '/v1/nutrients/reference', headers: { host, 'x-forwarded-for': ip }, payload: ref });
const mcp = (payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/mcp', headers: { host: DEMO, 'x-forwarded-for': '9.9.9.9', ...headers }, payload: payload as Record<string, unknown> });
const call = (id: number, session?: string) =>
  mcp({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'nutrients_reference', arguments: ref } }, session ? { 'mcp-session-id': session } : {});

describe('free trial on the demo hostname', () => {
  it('meters REST calls per IP, with headers, then answers 429 with the paid route', async () => {
    const seen = [];
    for (let i = 0; i < 3; i++) seen.push((await rest('1.1.1.1')).headers['x-free-tier-remaining']);
    expect(seen).toEqual(['2', '1', '0']);
    const res = await rest('1.1.1.1');
    expect(res.statusCode).toBe(429);
    const body = res.json();
    expect(body.error).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    expect(body.error.message).toMatch(/3 free calls for today; it resets at 00:00 UTC .*Pocket Network/);
    expect(body.free_tier).toMatchObject({ scope: 'ip', limit: 3, resets_at: '2026-10-12T00:00:00Z' });
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('never meters other hosts (paid relays) or discovery routes', async () => {
    for (let i = 0; i < 5; i++) expect((await rest('1.1.1.1', 'dietary-supplement-analysis-backend:8080')).statusCode).toBe(200);
    const tools = await app.inject({ method: 'GET', url: '/v1/tools', headers: { host: DEMO, 'x-forwarded-for': '1.1.1.1' } });
    expect(tools.statusCode).toBe(200);
    expect(tools.headers['x-free-tier-remaining']).toBeUndefined();
  });

  it('gives each MCP connection its own small quota and answers readably when it is used up', async () => {
    const init = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    const session = init.headers['mcp-session-id'] as string;
    expect(session).toMatch(/^[0-9a-f-]{36}$/);
    expect((await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-session-id': session })).json().result.tools.length).toBeGreaterThan(0);
    const first = (await call(3, session)).json().result;
    expect(first.isError).toBe(false);
    expect(first._meta.free_tier).toMatchObject({ remaining: 1, limit: 2 });
    expect((await call(4, session)).json().result.isError).toBe(false);
    const third = (await call(5, session)).json().result;
    expect(third.isError).toBe(true);
    expect(third.content[0].text).toMatch(/This connection has used its 2 free checks for today/);
    expect(third.structuredContent.free_tier.scope).toBe('session');
    // A new connection from the same address works, up to the per-IP MCP ceiling.
    expect((await call(6, 'other')).json().result.isError).toBe(false);
  });

  it('caps all free traffic per day, and resets at midnight UTC', async () => {
    // Used so far today: 3 REST + 3 MCP = 6 of 8.
    expect((await rest('2.2.2.2')).statusCode).toBe(200);
    expect((await rest('3.3.3.3')).statusCode).toBe(200);
    const capped = await rest('4.4.4.4');
    expect(capped.statusCode).toBe(429);
    expect(capped.json().free_tier.scope).toBe('global');
    clock = new Date('2026-10-12T00:00:01Z');
    expect((await rest('4.4.4.4')).statusCode).toBe(200);
    expect((await rest('1.1.1.1')).statusCode).toBe(200);
  });

  it('ignores caller-supplied X-Forwarded-For entries (only the proxy-appended last one counts)', async () => {
    const t = new FreeTier([DEMO], { ...limits, perIpRest: 1, global: 100 }, null, () => new Date('2026-10-11T12:00:00Z'));
    const a = buildApp({ dsld: fixtureClient(), freeTier: t });
    const go = (xff: string) => a.inject({ method: 'POST', url: '/v1/nutrients/reference', headers: { host: DEMO, 'x-forwarded-for': xff }, payload: ref });
    expect((await go('6.6.6.6, 7.7.7.7')).statusCode).toBe(200);
    expect((await go('8.8.8.8, 7.7.7.7')).statusCode).toBe(429); // spoofed first entry changed, real client the same
    await a.close();
  });

  it('groups IPv6 by /64 and reads IPv4-mapped addresses', () => {
    expect(ipKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(ipKey('::ffff:10.0.0.1')).toBe('10.0.0.1');
  });

  it('keeps counts across restarts in SQLite, storing hashes, not addresses', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ft-'));
    const file = path.join(dir, 'free-tier.sqlite');
    const now = () => new Date('2026-10-11T12:00:00Z');
    const a = await openFreeTier([DEMO], { ...limits, perIpRest: 2 }, file);
    const a2 = new FreeTier([DEMO], { ...limits, perIpRest: 2 }, (a as unknown as { db: never }).db, now);
    expect(a2.take('rest', '5.5.5.5').ok).toBe(true);
    a.close();
    const b = await openFreeTier([DEMO], { ...limits, perIpRest: 2 }, file);
    const b2 = new FreeTier([DEMO], { ...limits, perIpRest: 2 }, (b as unknown as { db: never }).db, now);
    expect(b2.take('rest', '5.5.5.5').ok).toBe(true);
    expect(b2.take('rest', '5.5.5.5').ok).toBe(false);
    b.close();
    expect(readFileSync(file).includes(Buffer.from('5.5.5.5'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
