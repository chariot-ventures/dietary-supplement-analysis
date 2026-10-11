import { describe, expect, it } from 'vitest';
import { DsldClient, Semaphore } from '../src/lib/dsld.js';
import { AppError } from '../src/lib/errors.js';
import { fixtureClient, fixtureLabel } from './helpers.js';

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('DsldClient', () => {
  it('encodes search params and uses status=1 for on-market only', async () => {
    const urls: string[] = [];
    const client = fixtureClient({}, (u) => urls.push(u));
    await client.search({ query: 'vitamin d3 & k2/mk-7', brand: 'NOW', onMarketOnly: true, size: 5 });
    const u = new URL(urls[0]!);
    expect(u.pathname).toBe('/dsld/v9/search-filter');
    expect(u.searchParams.get('q')).toBe('vitamin d3 & k2/mk-7');
    expect(u.searchParams.get('status')).toBe('1');
    expect(u.searchParams.get('size')).toBe('5');
    expect(urls[0]).not.toContain(' & ');
  });

  it('caches labels and searches', async () => {
    const urls: string[] = [];
    const client = fixtureClient({}, (u) => urls.push(u));
    await client.getLabel(900001);
    await client.getLabel(900001);
    await client.search({ query: 'vitamin', onMarketOnly: true, size: 5 });
    await client.search({ query: 'vitamin', onMarketOnly: true, size: 5 });
    expect(urls).toHaveLength(2);
  });

  it('dedupes concurrent requests for the same label', async () => {
    const urls: string[] = [];
    const client = fixtureClient({}, (u) => urls.push(u));
    await Promise.all([client.getLabel(900002), client.getLabel(900002), client.getLabel(900002)]);
    expect(urls).toHaveLength(1);
  });

  it('maps a DSLD 404 or an empty body to NOT_FOUND', async () => {
    await expect(fixtureClient().getLabel(1)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const empty = new DsldClient({ fetchImpl: async () => jsonResponse({}) });
    await expect(empty.getLabel(5)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns UPSTREAM_UNAVAILABLE (retryable) when DSLD fails and nothing is cached', async () => {
    const client = new DsldClient({ fetchImpl: async () => jsonResponse({ message: 'down' }, 503) });
    const err = await client.getLabel(900001).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', retryable: true, status: 424 });
  });

  it('serves a stale cached label when DSLD fails', async () => {
    let up = true;
    const client = new DsldClient({
      labelTtlMs: 1,
      fetchImpl: async () => (up ? jsonResponse(fixtureLabel(900001)) : jsonResponse({}, 502)),
    });
    await client.getLabel(900001);
    await new Promise((r) => setTimeout(r, 5));
    up = false;
    await expect(client.getLabel(900001)).resolves.toMatchObject({ label: { id: 900001 } });
  });

  it('retries once on a network error, not on HTTP errors', async () => {
    let calls = 0;
    const flaky = new DsldClient({
      fetchImpl: async () => {
        calls++;
        if (calls === 1) throw new TypeError('fetch failed');
        return jsonResponse(fixtureLabel(900001));
      },
    });
    await expect(flaky.getLabel(900001)).resolves.toBeDefined();
    expect(calls).toBe(2);

    let httpCalls = 0;
    const http = new DsldClient({ fetchImpl: async () => (httpCalls++, jsonResponse({}, 500)) });
    await http.getLabel(900001).catch(() => undefined);
    expect(httpCalls).toBe(1);
  });

  it('gives up after the per-request deadline', async () => {
    const slow = new DsldClient({
      requestDeadlineMs: 50,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        }),
    });
    const started = Date.now();
    await expect(slow.getLabel(900001)).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('sends X-Api-Key only when configured', async () => {
    const seen: (string | null)[] = [];
    const capture = async (_u: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('x-api-key'));
      return jsonResponse(fixtureLabel(900001));
    };
    await new DsldClient({ fetchImpl: capture }).getLabel(900001);
    await new DsldClient({ fetchImpl: capture, apiKey: 'k' }).getLabel(900001);
    expect(seen).toEqual([null, 'k']);
  });

  it('never runs more than 4 upstream requests at once', async () => {
    let active = 0;
    let peak = 0;
    const client = new DsldClient({
      fetchImpl: async (url) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        const id = Number(url.split('/').pop());
        return jsonResponse({ ...fixtureLabel(900001), id });
      },
    });
    await client.getLabels(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(peak).toBe(4);
  });
});

describe('Semaphore', () => {
  it('runs tasks in FIFO order under the limit', async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((n) => sem.run(async () => order.push(n))));
    expect(order).toEqual([1, 2, 3]);
  });
});
