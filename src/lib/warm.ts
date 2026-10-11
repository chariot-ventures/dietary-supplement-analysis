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
  const interval = o.intervalMs ?? 24 * 60 * 60 * 1000;
  const run = async () => {
    // Restarts (every deploy) must not repeat a recent pass: each pass costs DSLD API calls.
    const last = Number(client.store?.getMeta('warm_last_pass') ?? 0);
    const wait = last + interval - Date.now();
    if (wait > 0) {
      o.log?.('label store warm pass skipped (recent)', { next_in_minutes: Math.round(wait / 60000) });
      await sleep(wait, ctrl.signal);
    }
    while (!ctrl.signal.aborted) {
      // With the full NIH dump imported, the warmer has nothing to add.
      if (client.store?.getMeta('mirror_version')) {
        o.log?.('label store warm pass skipped (mirror present)');
        await sleep(interval, ctrl.signal);
        continue;
      }
      const started = Date.now();
      const r = await warmOnce(client, { ...o, signal: ctrl.signal }).catch(() => ({ fetched: 0, skipped: 0, failed: -1 }));
      o.log?.('label store warm pass done', { ...r, stored: safeCount(client), seconds: Math.round((Date.now() - started) / 1000) });
      try {
        client.store?.setMeta('warm_last_pass', String(Date.now()));
      } catch {
        /* read-only store: the pass simply repeats next start */
      }
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
