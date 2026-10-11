import { describe, expect, it } from 'vitest';
import { DsldClient } from '../src/lib/dsld.js';
import { createFixtureFetch } from '../src/lib/dsld-fixtures.js';
import { ftsQuery, openLabelStore } from '../src/lib/store.js';
import { warmOnce } from '../src/lib/warm.js';
import { fixtureLabel, fixtureLabels } from './helpers.js';

async function memStore() {
  const { store, error } = await openLabelStore(':memory:');
  if (!store) throw new Error(error);
  return store;
}

const down = async (): Promise<Response> => {
  throw new TypeError('fetch failed');
};

describe('label store', () => {
  it('stores labels and finds them by words, brand, ingredient and barcode', async () => {
    const s = await memStore();
    for (const id of [900001, 900002, 900003, 900007]) s.putLabel(fixtureLabel(id), '2026-10-01');
    s.putLabel(fixtureLabel(900003), '2026-10-02'); // upsert, no duplicate in the index
    expect(s.count()).toBe(4);
    expect(s.getLabel(900003)).toMatchObject({ retrieved: '2026-10-02', label: { fullName: 'Magnesium Glycinate 200' } });
    expect(s.search({ query: 'magnesium glycin', onMarketOnly: true, size: 5 }).hits.map((h) => h.id)).toEqual([900003]);
    expect(s.search({ brand: 'fixture labs', ingredient: 'zinc', onMarketOnly: true, size: 5 }).hits.map((h) => h.id)).toContain(900007);
    expect(s.findUpc('012345678905')).toEqual([expect.objectContaining({ id: 900007, entry_date: '2023-06-01', on_market: true })]);
  });

  it('builds safe FTS queries from free text', () => {
    expect(ftsQuery("Women's 50+ \"multi\" OR *")).toBe('"womens"* AND "50"* AND "multi"* AND "or"*');
    expect(ftsQuery('  ')).toBeNull();
  });

  it('writes through, then serves labels and searches when DSLD is down', async () => {
    const store = await memStore();
    const live = new DsldClient({ fetchImpl: createFixtureFetch(fixtureLabels), store });
    await live.getLabel(900002);
    await live.getLabel(900007);
    expect(store.count()).toBe(2);

    // A new process (empty memory cache) with NIH unreachable: stored labels still answer.
    const offline = new DsldClient({ fetchImpl: down, store, storeFreshDays: 0 });
    expect((await offline.getLabel(900002)).label.fullName).toBe('Daily Multivitamin');
    const r = await offline.search({ query: 'zinc', onMarketOnly: true, size: 5 });
    expect(r.source).toBe('local');
    expect(r.ids).toEqual([900007, 900002]); // name matches rank above ingredient matches
    const upc = await offline.search({ query: '"0 12345 67890 5"', onMarketOnly: false, size: 5 });
    expect(upc.ids).toEqual([900007]);
    await expect(offline.getLabel(900001)).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });

  it('fresh stored labels are served without a network call', async () => {
    const store = await memStore();
    store.putLabel(fixtureLabel(900001), new Date().toISOString().slice(0, 10));
    const urls: string[] = [];
    const client = new DsldClient({ fetchImpl: createFixtureFetch(fixtureLabels, (u) => urls.push(u)), store });
    await client.getLabel(900001);
    expect(urls).toEqual([]);
  });

  it('the warmer fetches search results it does not hold yet', async () => {
    const store = await memStore();
    store.putLabel(fixtureLabel(900003), '2026-10-01');
    const client = new DsldClient({ fetchImpl: createFixtureFetch(fixtureLabels), store });
    const r = await warmOnce(client, { queries: ['magnesium', 'zinc'], perQuery: 10, delayMs: 0 });
    expect(r.skipped).toBe(1);
    expect(r.fetched).toBeGreaterThanOrEqual(2);
    expect(store.findUpc('012345678905').length).toBe(2);
  });
});
