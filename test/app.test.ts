import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { DsldClient } from '../src/lib/dsld.js';
import { buildOpenApi } from '../src/openapi.js';
import { ROOT, fixtureClient, testApp } from './helpers.js';

import { GATEWAY_PHRASES } from '../src/lib/phrases.js';
const FORBIDDEN_WORDING = [/\bsafe\b/i, /\bno risk\b/i, /\bno interactions\b/i];

const app = testApp();
afterAll(() => app.close());

const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as Record<string, unknown> });
const STACK = {
  age: 34,
  sex: 'female',
  products: [{ dsld_id: 900001 }, { dsld_id: 900002 }, { dsld_id: 900005 }, { name: 'Custom magnesium', ingredients: [{ name: 'magnesium', amount: 250, unit: 'mg' }] }],
};

const SUCCESS_CALLS: [string, string, unknown?][] = [
  ['GET', '/'],
  ['GET', '/v1/version'],
  ['GET', '/v1/health'],
  ['GET', '/openapi.json'],
  ['POST', '/v1/products/search', { query: 'vitamin' }],
  ['POST', '/v1/products/get', { dsld_ids: [900001, 900002, 900004, 900005] }],
  ['POST', '/v1/products/lookup', { upc: '012345678905' }],
  ['GET', '/v1/tools'],
  ['GET', '/v1/guide'],
  ['POST', '/v1/stack/analyze', { age: 62, sex: 'female', products: [{ query: 'zinc 50' }, { dsld_id: 900008 }], candidates: [{ upc: '012345678912' }] }],
  ['POST', '/v1/nutrients/reference', { nutrient: 'vitamin-d', age: 30, sex: 'female' }],
  ['POST', '/v1/stack/analyze', STACK],
  ['POST', '/v1/stack/analyze', { products: [{ dsld_id: 900003 }] }],
  ['POST', '/v1/tool', { tool: 'stack_analyze', arguments: STACK }],
];

describe('identity and health', () => {
  it('/v1/version is exactly service + version', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/version' });
    expect(res.json()).toEqual({ service: 'dietary-supplement-analysis', version: '0.12.0' });
  });

  it('version matches package.json', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string };
    expect(pkg.version).toBe('0.12.0');
  });

  it('GET / and HEAD / answer 2xx JSON', async () => {
    const get = await app.inject({ method: 'GET', url: '/' });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({ service: 'dietary-supplement-analysis', status: 'ok' });
    const head = await app.inject({ method: 'HEAD', url: '/' });
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-type']).toMatch(/application\/json/);
  });

  it('card health checks pass', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/version' })).json().service).toMatch(/^dietary-supplement-analysis$/);
    expect((await app.inject({ method: 'GET', url: '/v1/health' })).json().status).toMatch(/^ok$/);
    const ref = await post('/v1/nutrients/reference', { nutrient: 'vitamin-d', age: 30, sex: 'female' });
    expect(ref.json().nutrient.id).toMatch(/^vitamin-d$/);
  });
});

describe('gateway rules on success bodies', () => {
  it.each(SUCCESS_CALLS)('%s %s', async (method, url, payload) => {
    const res = await app.inject({ method: method as 'GET' | 'POST', url, headers: { 'accept-encoding': 'gzip, br' }, ...(payload ? { payload: payload as object } : {}) });
    expect(res.statusCode).toBe(200);
    expect(res.body[0]).toBe('{');
    expect(res.headers['content-encoding']).toBeUndefined();
    const head = res.body.slice(0, 2048).toLowerCase();
    for (const phrase of GATEWAY_PHRASES) expect(head).not.toContain(phrase);
    expect(res.body).not.toMatch(/"timeout"\s*:/);
    if (url !== '/openapi.json') for (const re of FORBIDDEN_WORDING) expect(res.body).not.toMatch(re);
  });

  it('common fields come first and the disclaimer is present', async () => {
    const res = await post('/v1/stack/analyze', STACK);
    const keys = Object.keys(res.json());
    expect(keys.slice(0, 3)).toEqual(['service', 'version', 'as_of']);
    expect(keys.at(-1)).toBe('disclaimer');
    expect(keys.indexOf('summary')).toBeLessThan(keys.indexOf('nutrient_totals'));
  });
});

describe('errors are 4xx JSON, never 5xx', () => {
  const ROUTES = ['/v1/products/search', '/v1/products/get', '/v1/nutrients/reference', '/v1/stack/analyze', '/v1/tool'];
  const BAD_BODIES: unknown[] = [
    undefined,
    '',
    'not json',
    '{"unterminated": ',
    '[]',
    '[1,2,3]',
    'null',
    '42',
    '"string"',
    '{}',
    { query: '' },
    { query: 'x'.repeat(500) },
    { limit: 0, query: 'a' },
    { limit: 11, query: 'a' },
    { dsld_id: -1 },
    { dsld_id: 1.5 },
    { dsld_id: '900001' },
    { dsld_id: 900001, dsld_ids: [900001] },
    { dsld_ids: [] },
    { dsld_ids: Array.from({ length: 11 }, (_, i) => i + 1) },
    { nutrient: 'vitamin-d' },
    { nutrient: 'vitamin-d', age: 30, sex: 'other' },
    { nutrient: 'vitamin-d', age: -1, sex: 'male' },
    { nutrient: 'vitamin-d', age: 500, sex: 'male' },
    { nutrient: 'vitamin-d', age: 30, sex: 'male', life_stage: 'pregnancy' },
    { nutrient: 'unobtainium', age: 30, sex: 'male' },
    { products: [] },
    { products: 'all of them' },
    { products: Array.from({ length: 16 }, () => ({ dsld_id: 900001 })) },
    { products: [{}] },
    { products: [{ dsld_id: 1 }] },
    { products: [{ dsld_id: 900001, ingredients: [] }] },
    { products: [{ ingredients: [{ name: 'zinc', amount: -5, unit: 'mg' }] }] },
    { products: [{ ingredients: [{ name: 'zinc', amount: 5 }] }] },
    { age: 30, products: [{ dsld_id: 900001 }] },
    { age: 60, sex: 'female', pregnant: true, products: [{ dsld_id: 900001 }] },
    { lactating: true, products: [{ dsld_id: 900001 }] },
    { age: 30, sex: 'female', life_stage: 'menopause', products: [{ dsld_id: 900001 }] },
    { tool: 'rm -rf', arguments: {} },
    { tool: 'stack_analyze', arguments: { products: [] } },
    { tool: 'stack_analyze', arguments: 'x' },
    { __proto__: { polluted: true }, constructor: { prototype: { x: 1 } } },
  ];

  for (const route of ROUTES) {
    it(`fuzz ${route}`, async () => {
      for (const body of BAD_BODIES) {
        const res = await app.inject({
          method: 'POST',
          url: route,
          headers: { 'content-type': 'application/json' },
          ...(body === undefined ? {} : { payload: typeof body === 'string' ? body : JSON.stringify(body) }),
        });
        const label = `${route} ${JSON.stringify(body)}`;
        expect(res.statusCode, label).toBeGreaterThanOrEqual(400);
        expect(res.statusCode, label).toBeLessThan(500);
        expect(res.body[0], label).toBe('{');
        const err = res.json().error;
        expect(err, label).toMatchObject({ code: expect.any(String), message: expect.any(String), retryable: false });
      }
    });
  }

  it('maps codes to statuses', async () => {
    expect((await post('/v1/products/get', { dsld_id: 1 })).statusCode).toBe(404);
    expect((await post('/v1/products/get', { dsld_id: 1 })).json().error).toMatchObject({ code: 'NOT_FOUND', field: 'dsld_id' });
    expect((await post('/v1/stack/analyze', { products: [{ dsld_id: 900001 }, { dsld_id: 2 }] })).json().error.field).toBe('products.1.dsld_id');
    const preg = await post('/v1/stack/analyze', { age: 55, sex: 'female', pregnant: true, products: [{ dsld_id: 900001 }] });
    expect(preg.statusCode).toBe(422);
    expect(preg.json().error).toMatchObject({ code: 'UNSUPPORTED', field: 'age' });
    const male = await post('/v1/nutrients/reference', { nutrient: 'iron', age: 30, sex: 'male', life_stage: 'lactation' });
    expect(male.json().error).toMatchObject({ code: 'INVALID_INPUT', field: 'life_stage' });
    const invalid = await post('/v1/products/search', { limit: 50, query: 'x' });
    expect(invalid.json().error).toMatchObject({ code: 'INVALID_INPUT', field: 'limit' });
  });

  it('unknown routes and methods are 404 JSON', async () => {
    for (const [method, url] of [['GET', '/nope'], ['GET', '/v1/stack/analyze'], ['DELETE', '/'], ['POST', '/v1/version']] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode).toBe(404);
      expect(res.body[0]).toBe('{');
    }
  });

  it('upstream failure is 424 UPSTREAM_UNAVAILABLE and retryable', async () => {
    const down = buildApp({ dsld: new DsldClient({ fetchImpl: async () => new Response('<html>502</html>', { status: 502 }) }) });
    for (const [url, payload] of [
      ['/v1/stack/analyze', { products: [{ dsld_id: 900001 }] }],
      ['/v1/products/search', { query: 'zinc' }],
      ['/v1/products/get', { dsld_id: 900001 }],
    ] as const) {
      const res = await down.inject({ method: 'POST', url, payload });
      expect(res.statusCode, url).toBe(424);
      expect(res.json().error, url).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', retryable: true });
    }
    // Offline routes keep working.
    expect((await down.inject({ method: 'POST', url: '/v1/nutrients/reference', payload: { nutrient: 'zinc', age: 40, sex: 'male' } })).statusCode).toBe(200);
    await down.close();
  });

  it('unexpected exceptions become a JSON 4xx, not a 5xx', async () => {
    const broken = buildApp({ dsld: { getLabel: () => { throw new Error('boom'); } } as unknown as DsldClient });
    const res = await broken.inject({ method: 'POST', url: '/v1/stack/analyze', payload: { products: [{ dsld_id: 900001 }] } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({ code: 'INTERNAL_ERROR' });
    await broken.close();
  });
});

describe('request parsing', () => {
  it('parses JSON whatever the content type, including none', async () => {
    for (const ct of ['application/json', 'text/plain', 'application/x-www-form-urlencoded', undefined]) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/nutrients/reference',
        headers: ct ? { 'content-type': ct } : {},
        payload: '{"nutrient":"zinc","age":40,"sex":"male"}',
      });
      expect(res.statusCode, String(ct)).toBe(200);
    }
  });

  it('accepts chunked bodies with no Content-Length', async () => {
    const server = testApp();
    await server.listen({ port: 0, host: '127.0.0.1' });
    const { port } = server.server.address() as AddressInfo;
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/stack/analyze', headers: { 'transfer-encoding': 'chunked' } }, (res) => {
        let data = '';
        res.on('data', (c: Buffer) => (data += c.toString()));
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      const payload = JSON.stringify(STACK);
      for (let i = 0; i < payload.length; i += 17) req.write(payload.slice(i, i + 17));
      req.end();
    });
    await server.close();
    expect(JSON.parse(body).summary.products_matched).toBe(4);
  });
});

describe('gateway phrase escaping', () => {
  it('escapes phrases from caller and upstream text but returns identical strings', async () => {
    const res = await post('/v1/products/search', { query: 'Gateway Timeout block not found' });
    expect(res.statusCode).toBe(200);
    const lower = res.body.toLowerCase();
    for (const phrase of GATEWAY_PHRASES) expect(lower).not.toContain(phrase);
    expect(res.json().query.query).toBe('Gateway Timeout block not found');
  });
});

describe('upstream budget', () => {
  it('stops waiting on DSLD after the request budget and answers 424', async () => {
    const slow = buildApp({
      upstreamBudgetMs: 300,
      dsld: new DsldClient({
        concurrency: 1,
        fetchImpl: (_url, init) => new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))),
      }),
    });
    const started = Date.now();
    const res = await slow.inject({ method: 'POST', url: '/v1/stack/analyze', payload: { products: [1, 2, 3, 4, 5, 6].map((id) => ({ dsld_id: id })) } });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(res.statusCode).toBe(424);
    expect(res.json().error).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', retryable: true });
    await slow.close();
  });
});

describe('logging', () => {
  it('logs method, path, status and duration only; never bodies or queries', async () => {
    const lines: string[] = [];
    const stream = new Writable({ write(chunk: Buffer, _enc, cb) { lines.push(chunk.toString()); cb(); } });
    const logged = buildApp({ dsld: fixtureClient(), logger: { level: 'info', stream } });
    await logged.inject({ method: 'POST', url: '/v1/stack/analyze?secret=querystring', payload: { age: 61, sex: 'female', products: [{ name: 'Private stack', ingredients: [{ name: 'zinc', amount: 77, unit: 'mg' }] }] } });
    await logged.inject({ method: 'POST', url: '/v1/stack/analyze', payload: 'not json at all' });
    await logged.close();
    const all = lines.join('\n');
    expect(lines.length).toBeGreaterThan(0);
    for (const secret of ['Private stack', 'zinc', '"age"', 'female', 'querystring', 'not json at all']) expect(all).not.toContain(secret);
    expect(JSON.parse(lines[0]!)).toMatchObject({ method: 'POST', path: '/v1/stack/analyze', status: 200 });
  });
});

describe('tool route', () => {
  it('returns the same body as the direct route', async () => {
    const direct = (await post('/v1/nutrients/reference', { nutrient: 'iron', age: 25, sex: 'female' })).json();
    const viaTool = (await post('/v1/tool', { tool: 'nutrients_reference', arguments: { nutrient: 'iron', age: 25, sex: 'female' } })).json();
    expect(viaTool).toEqual(direct);
  });
});

describe('openapi', () => {
  it('committed openapi/openapi.json matches the code', () => {
    const committed: unknown = JSON.parse(readFileSync(path.join(ROOT, 'openapi/openapi.json'), 'utf8'));
    expect(committed).toEqual(buildOpenApi());
  });

  it('is served at /openapi.json', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.json()).toMatchObject({ openapi: '3.1.0', paths: { '/v1/stack/analyze': { post: expect.any(Object) } } });
  });
});

describe('latency (simulated upstream)', () => {
  let slowApp: ReturnType<typeof buildApp>;
  const DELAY_MS = 400;
  beforeAll(() => {
    const base = fixtureClient();
    const client = new DsldClient({
      fetchImpl: async (url) => {
        await new Promise((r) => setTimeout(r, DELAY_MS));
        const id = Number(url.split('/').pop());
        const { label } = await base.getLabel(900002);
        return new Response(JSON.stringify({ ...label, id }));
      },
    });
    slowApp = buildApp({ dsld: client });
  });
  afterAll(() => slowApp.close());

  it(`10-product analyze: cold < 5 s with ${DELAY_MS} ms per DSLD call, warm < 1 s`, async () => {
    const payload = { age: 40, sex: 'male', products: Array.from({ length: 10 }, (_, i) => ({ dsld_id: 800001 + i })) };
    let t = Date.now();
    const cold = await slowApp.inject({ method: 'POST', url: '/v1/stack/analyze', payload });
    const coldMs = Date.now() - t;
    t = Date.now();
    const warm = await slowApp.inject({ method: 'POST', url: '/v1/stack/analyze', payload });
    const warmMs = Date.now() - t;
    expect(cold.statusCode).toBe(200);
    expect(warm.statusCode).toBe(200);
    expect(coldMs).toBeLessThan(5000);
    expect(warmMs).toBeLessThan(1000);
  });
});
