import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { distinctiveWords, matchRecall, OpenFdaClient, words, type FetchLike } from '../src/lib/openfda.js';
import { fixtureClient, fixtureLabels } from './helpers.js';

const recalls = {
  meta: { last_updated: '2026-09-30', results: { total: 20 } },
  results: [
    {
      recall_number: 'F-0779-2015',
      classification: 'Class I',
      status: 'Terminated',
      reason_for_recall: 'Possible contamination with Listeria monocytogenes.',
      product_description: 'Nature Made Snack Pack W/ Cheese Net Wt. 7 oz. (198g) UPC 717524720627',
      recalling_firm: 'Del Monte Fresh Produce NA, Inc',
      recall_initiation_date: '20141209',
      report_date: '20150121',
    },
    {
      recall_number: 'F-2077-2016',
      classification: 'Class II',
      status: 'Terminated',
      reason_for_recall: 'Specific lots of Nature Made(R) Vitamin D tablets may exceed specifications for yeast/mold.',
      product_description: 'Nature Made(R) D3 1000IU, 125 count, UPC 0-31604-02793-3',
      recalling_firm: 'Pharmavite',
      recall_initiation_date: '20160606',
      report_date: '20160914',
    },
  ],
};

function stubFda(calls: string[] = [], opts: { productEvents?: number; down?: boolean } = {}): FetchLike {
  return async (url) => {
    calls.push(url);
    if (opts.down) throw new Error('offline');
    const u = new URL(url);
    if (u.pathname === '/food/enforcement.json') return Response.json(recalls);
    const search = u.searchParams.get('search') ?? '';
    const productLevel = search.includes(' AND ');
    if (u.searchParams.get('count')) return Response.json({ results: [{ term: 'NAUSEA', count: 12 }, { term: 'VOMITING', count: 7 }] });
    const total = productLevel ? (opts.productEvents ?? 0) : 5420;
    if (!total) return Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
    return Response.json({ meta: { last_updated: '2026-07-07', results: { total } }, results: [{}] });
  };
}

describe('recall matching', () => {
  const key = { brand: 'Nature Made', name: 'Vitamin D3 1000 IU Softgels', upc: '031604027933' };

  it('splits words and drops brand, units and dosage forms', () => {
    expect(words('D3 1000IU')).toEqual(['d', '3', '1000', 'iu']);
    expect(distinctiveWords(key)).toEqual(['vitamin', 'd', '3', '1000']);
  });

  it('matches on the barcode core digits however the recall formats them', () => {
    expect(matchRecall('Nature Made(R) D3 1000IU, 125 count, UPC 0-31604-02793-3', key)).toBe('upc');
  });

  it('matches on brand plus every name word, and never on the brand alone', () => {
    expect(matchRecall('NATURE MADE VITAMIN D3 1000 IU softgels lot 123', { ...key, upc: null })).toBe('brand_and_name');
    expect(matchRecall('Nature Made Snack Pack W/ Cheese', { ...key, upc: null })).toBeNull();
    expect(matchRecall('Nature Made(R) D3 1000IU, 125 count', { ...key, upc: null })).toBeNull(); // "vitamin" missing: not claimed
  });
});

describe('POST /v1/products/fda', () => {
  const calls: string[] = [];
  const app = buildApp({ dsld: fixtureClient(), openfda: new OpenFdaClient(stubFda(calls, { productEvents: 31 }), 'https://fda.test') });
  afterAll(() => app.close());

  it('lists matched recalls and counts the rest, with adverse events and the FDA caveat', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/products/fda', payload: { brand: 'Nature Made', name: 'D3 1000 IU' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.recalls.matched.map((r: { recall_number: string }) => r.recall_number)).toEqual(['F-2077-2016']);
    expect(body.recalls.matched[0]).toMatchObject({ matched_by: 'brand_and_name', recall_initiation_date: '2016-06-06', classification: 'Class II' });
    expect(body.recalls.brand_recalls_total).toBe(20);
    expect(body.adverse_events).toMatchObject({ scope: 'product', total: 31, top_reactions: [{ term: 'nausea', count: 12 }, { term: 'vomiting', count: 7 }] });
    expect(body.agent_summary).toMatch(/FDA lists 1 recall matching Nature Made D3 1000 IU; the latest \(Class II, 2016, terminated\)/);
    expect(body.agent_summary).toMatch(/does not show that the product caused/);
    expect(body.sources[0].url).toMatch(/^https:\/\/fda\.test\/food\/enforcement\.json\?search=/);
  });

  it('resolves a DSLD ID to its brand, name and barcode first', async () => {
    const [id, label] = [...fixtureLabels].find(([, l]) => l.brandName && l.upcSku)!;
    const body = (await app.inject({ method: 'POST', url: '/v1/products/fda', payload: { dsld_id: id } })).json();
    expect(body.product).toMatchObject({ dsld_id: id, brand: label.brandName });
  });

  it('falls back to brand-level adverse event counts when no report names the product', async () => {
    const quiet = buildApp({ dsld: fixtureClient(), openfda: new OpenFdaClient(stubFda([], { productEvents: 0 }), 'https://fda.test') });
    const body = (await quiet.inject({ method: 'POST', url: '/v1/products/fda', payload: { brand: 'Nature Made', name: 'Zinc 30 mg' } })).json();
    await quiet.close();
    expect(body.recalls.matched).toEqual([]);
    expect(body.adverse_events).toMatchObject({ scope: 'brand', total: 5420, top_reactions: [] });
    expect(body.agent_summary).toMatch(/No FDA recall matches Nature Made Zinc 30 mg .*20 recall records mention the brand/);
  });

  it('reports openFDA outages as data gaps, still 200', async () => {
    const down = buildApp({ dsld: fixtureClient(), openfda: new OpenFdaClient(stubFda([], { down: true }), 'https://fda.test') });
    const res = await down.inject({ method: 'POST', url: '/v1/products/fda', payload: { brand: 'Acme', name: 'Iron' } });
    await down.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().data_gaps.map((g: { code: string }) => g.code)).toEqual(['FDA_UNAVAILABLE', 'FDA_UNAVAILABLE']);
  });

  it('caches openFDA answers', async () => {
    const n = calls.length;
    await app.inject({ method: 'POST', url: '/v1/products/fda', payload: { brand: 'Nature Made', name: 'D3 1000 IU' } });
    expect(calls.length).toBe(n);
  });

  it('validates input and answers 422 when FDA lookups are off', async () => {
    expect((await app.inject({ method: 'POST', url: '/v1/products/fda', payload: { name: 'x' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/v1/products/fda', payload: { brand: 'A', name: 'B', upc: '031604027933' } })).statusCode).toBe(400);
    const off = buildApp({ dsld: fixtureClient() });
    expect((await off.inject({ method: 'POST', url: '/v1/products/fda', payload: { brand: 'Ab', name: 'B' } })).statusCode).toBe(422);
    await off.close();
  });

  it('is reachable as a tool', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/tool', payload: { tool: 'products_fda_reports', arguments: { brand: 'Nature Made', name: 'D3 1000 IU' } } });
    expect(res.statusCode).toBe(200);
  });
});
