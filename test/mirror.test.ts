import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lookupUpc } from '../src/lib/catalog.js';
import { DsldClient } from '../src/lib/dsld.js';
import { openLabelStore } from '../src/lib/store.js';
import { fixtureLabel, ROOT } from './helpers.js';

async function mirrored() {
  const { store } = await openLabelStore(':memory:');
  for (const id of [900001, 900002, 900003, 900007]) store!.putLabel(fixtureLabel(id), '2026-01-16');
  store!.setMeta('mirror_version', 'Fri, 16 Jan 2026 08:54:25 GMT');
  return store!;
}

describe('NIH DSLD mirror', () => {
  it('serves labels from the imported dump without calling DSLD, however old the dump', async () => {
    const calls: string[] = [];
    const client = new DsldClient({ store: await mirrored(), fetchImpl: async (u) => (calls.push(String(u)), new Response('{}', { status: 500 })) });
    const r = await client.getLabel(900003);
    expect(r.label.fullName).toBe('Magnesium Glycinate 200');
    expect(calls).toEqual([]);
  });

  it('answers barcodes from the dump, and goes live only for barcodes it lacks', async () => {
    const calls: string[] = [];
    const client = new DsldClient({ store: await mirrored(), fetchImpl: async (u) => (calls.push(String(u)), Response.json({ hits: [], stats: { count: 0 } })) });
    const m = await lookupUpc(client, '012345678905', {});
    expect(m.versions[0]!.id).toBe(900007);
    expect(calls).toEqual([]);
    await expect(lookupUpc(client, '099999999999', {})).rejects.toThrow(/No DSLD label/);
    expect(calls.length).toBe(1);
  });

  it('switches searches to the label store for a while after DSLD answers 429', async () => {
    let calls = 0;
    const client = new DsldClient({ store: await mirrored(), fetchImpl: async () => (calls++, new Response('{"error":"OVER_RATE_LIMIT"}', { status: 429 })) });
    const first = await client.search({ query: 'magnesium glycinate', onMarketOnly: true, size: 5 });
    expect(first.source).toBe('local');
    expect(calls).toBe(1);
    const second = await client.search({ query: 'zinc', onMarketOnly: true, size: 5 });
    expect(second.source).toBe('local');
    expect(calls).toBe(1); // no second call while backing off
  });

  it('imports newline-delimited labels into the store and records the dump version', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mirror-'));
    const db = path.join(dir, 'dsld.sqlite');
    const input = [fixtureLabel(900001), fixtureLabel(900002), { not: 'a label' }].map((l) => JSON.stringify(l)).join('\n') + '\nnot json\n';
    const r = spawnSync(process.execPath, ['--import', 'tsx', '--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/tools/import-dsld.ts'), db, 'v-test', '2026-01-16'], { input, encoding: 'utf8', cwd: ROOT });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/"imported":2,"skipped":2/);
    const { store } = await openLabelStore(db);
    expect(store!.count()).toBe(2);
    expect(store!.getMeta('mirror_version')).toBe('v-test');
    expect(store!.getLabel(900001)!.retrieved).toBe('2026-01-16');
    store!.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
