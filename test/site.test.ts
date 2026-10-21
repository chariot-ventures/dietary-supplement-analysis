import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { mcpServerEntry } from '../src/lib/site-content.js';
import { fixtureClient, ROOT } from './helpers.js';

const DEMO = 'agents.trackmysupplement.com';
const app = buildApp({ dsld: fixtureClient(), siteHosts: [DEMO] });
afterAll(() => app.close());
const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers: { host: DEMO, ...headers } });
const BROWSER = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };
const TEXT_FILES = ['/llms.txt', '/.well-known/llms.txt', '/llms-full.txt', '/agents.md', '/robots.txt', '/ai.txt', '/sitemap.xml'];

describe('landing page on the demo host', () => {
  it('serves HTML to browsers and JSON to agents at the same URL', async () => {
    const html = await get('/', BROWSER);
    expect(html.statusCode).toBe(200);
    expect(html.headers['content-type']).toMatch(/text\/html/);
    expect(html.headers.vary).toMatch(/Accept/);
    expect(html.headers['content-security-policy']).toMatch(/default-src 'self'/);
    expect(html.body).toMatch(/https:\/\/agents\.trackmysupplement\.com\/mcp/);
    expect(html.body).toMatch(/application\/ld\+json/);
    const agent = await get('/', { accept: '*/*' });
    expect(agent.headers['content-type']).toMatch(/application\/json/);
    expect(agent.json()).toMatchObject({ service: 'dietary-supplement-analysis', status: 'ok', llms_txt: '/llms.txt' });
  });

  it('keeps its JSON-LD parseable and never calls a stack safe', async () => {
    const body = (await get('/', BROWSER)).body;
    const ld = body.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)![1]!;
    expect(() => JSON.parse(ld)).not.toThrow();
    expect(body).not.toMatch(/\bis safe\b|no risk|risk-free/i);
  });

  it('serves every discovery file as text, linking the others', async () => {
    for (const url of TEXT_FILES) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type'], url).not.toMatch(/json/);
    }
    expect((await get('/llms.txt')).body).toMatch(/^# dietary-supplement-analysis/);
    expect((await get('/llms-full.txt')).body).toMatch(/### stack_analyze \(POST \/v1\/stack\/analyze\)/);
    expect((await get('/agents.md')).body).toMatch(/claude mcp add --transport http supplements https:\/\/agents\.trackmysupplement\.com\/mcp/);
    expect((await get('/robots.txt')).body).toMatch(/Sitemap: https:\/\/agents\.trackmysupplement\.com\/sitemap\.xml/);
  });
});

describe('relays and other hosts only ever see JSON', () => {
  it('answers JSON at / even for a browser Accept header', async () => {
    const res = await app.inject({ method: 'GET', url: '/', headers: { host: 'dietary-supplement-analysis-backend:8080', ...BROWSER } });
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('answers 404 JSON for the text files', async () => {
    for (const url of TEXT_FILES) {
      const res = await app.inject({ method: 'GET', url, headers: { host: 'dietary-supplement-analysis-backend:8080' } });
      expect(res.statusCode, url).toBe(404);
      expect(res.json().error.code, url).toBe('NOT_FOUND');
    }
  });
});

describe('machine-readable status', () => {
  it('reports version, accuracy and how to connect', async () => {
    const s = (await app.inject({ method: 'GET', url: '/status.json' })).json();
    expect(s).toMatchObject({ service: 'dietary-supplement-analysis', status: 'ok', access: { mcp: 'https://agents.trackmysupplement.com/mcp' } });
    const results = JSON.parse(readFileSync(path.join(ROOT, 'eval/results.json'), 'utf8')) as { passed: number; total: number };
    expect(s.accuracy).toMatchObject({ passed: results.passed, total: results.total });
  });

  it('serves the same MCP Registry entry as mcp/server.json', async () => {
    const file = JSON.parse(readFileSync(path.join(ROOT, 'mcp/server.json'), 'utf8'));
    expect(mcpServerEntry()).toEqual(file);
    expect((await app.inject({ method: 'GET', url: '/.well-known/mcp.json' })).json()).toEqual(file);
  });
});
