/**
 * Background warmer: fills the label store with popular products, slowly
 * (about one DSLD request per second), so common lookups never wait on NIH.
 * Runs once at startup and then every `intervalMs`. Never throws.
 */
import type { DsldClient } from './dsld.js';

export interface WarmOptions {
  queries: string[];
  perQuery: number;
  /** Pause between DSLD requests. */
  delayMs?: number;
  intervalMs?: number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
  signal?: AbortSignal;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

/** One pass over the queries. Returns how many labels were fetched from DSLD (not already stored). */
export async function warmOnce(client: DsldClient, o: WarmOptions): Promise<{ fetched: number; skipped: number; failed: number }> {
  let fetched = 0;
  let skipped = 0;
  let failed = 0;
  const seen = new Set<number>();
  for (const query of o.queries) {
    if (o.signal?.aborted) break;
    let ids: number[] = [];
    try {
      const r = await client.search({ query, onMarketOnly: true, size: o.perQuery });
      ids = r.source === 'dsld' ? r.ids : [];
    } catch {
      failed++;
    }
    await sleep(o.delayMs ?? 1000, o.signal);
    for (const id of ids) {
      if (o.signal?.aborted) break;
      if (seen.has(id)) continue;
      seen.add(id);
      if (client.store?.getLabel(id)) {
        skipped++;
        continue;
      }
      try {
        await client.getLabel(id);
        fetched++;
      } catch {
        failed++;
      }
      await sleep(o.delayMs ?? 1000, o.signal);
    }
  }
  return { fetched, skipped, failed };
}

export function startWarmer(client: DsldClient, o: WarmOptions): () => void {
  const ctrl = new AbortController();
  const run = async () => {
    while (!ctrl.signal.aborted) {
      const started = Date.now();
      const r = await warmOnce(client, { ...o, signal: ctrl.signal }).catch(() => ({ fetched: 0, skipped: 0, failed: -1 }));
      o.log?.('label store warm pass done', { ...r, stored: safeCount(client), seconds: Math.round((Date.now() - started) / 1000) });
      await sleep(o.intervalMs ?? 24 * 60 * 60 * 1000, ctrl.signal);
    }
  };
  void run();
  return () => ctrl.abort();
}

function safeCount(client: DsldClient): number | null {
  try {
    return client.store?.count() ?? null;
  } catch {
    return null;
  }
}
