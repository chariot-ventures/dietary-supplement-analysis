/**
 * Offline stand-in for the DSLD API, backed by label JSON files
 * (label-<id>.json). Used by tests and, via DSLD_FIXTURES_DIR, for local
 * demos when api.ods.od.nih.gov is unreachable. Never used in production.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { DsldLabel, FetchLike } from './dsld.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function loadFixtureLabels(dir: string): Map<number, DsldLabel> {
  const labels = new Map<number, DsldLabel>();
  for (const file of readdirSync(dir)) {
    const m = /^label-(\d+)\.json$/.exec(file);
    if (!m) continue;
    labels.set(Number(m[1]), JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as DsldLabel);
  }
  return labels;
}

export function createFixtureFetch(labels: Map<number, DsldLabel>, onRequest?: (url: string) => void): FetchLike {
  return async (url) => {
    onRequest?.(url);
    const u = new URL(url);
    const labelMatch = /\/label\/(\d+)$/.exec(u.pathname);
    if (labelMatch) {
      const label = labels.get(Number(labelMatch[1]));
      return label ? json(label) : json({ error: 'not found' }, 404);
    }
    if (u.pathname.endsWith('/search-filter')) {
      const q = (u.searchParams.get('q') ?? '').toLowerCase().trim();
      // A quoted query is a phrase (DSLD matches "0 31604 02697 4" against the UPC); otherwise every term must appear.
      const phrase = /^".*"$/.test(q) ? q.slice(1, -1) : null;
      const terms = phrase === null ? q.split(/\s+/).filter((t) => t && t !== '*') : [];
      const brand = u.searchParams.get('brand')?.toLowerCase();
      const ingredient = u.searchParams.get('ingredient_name')?.toLowerCase();
      const status = u.searchParams.get('status');
      const size = Number(u.searchParams.get('size') ?? 10);
      const hits = [...labels.values()].filter((l) => {
        const ingredientNames = (l.ingredientRows ?? []).flatMap((r) => [r.name, ...(r.forms ?? []).map((f) => f.name)]).join(' ').toLowerCase();
        const text = `${l.fullName ?? ''} ${l.brandName ?? ''} ${l.upcSku ?? ''} ${ingredientNames}`.toLowerCase();
        if (phrase !== null && !text.includes(phrase)) return false;
        if (terms.some((t) => !text.includes(t))) return false;
        if (brand && !(l.brandName ?? '').toLowerCase().includes(brand)) return false;
        if (ingredient && !ingredientNames.includes(ingredient)) return false;
        if (status === '1' && l.offMarket !== 0) return false;
        if (status === '0' && l.offMarket === 0) return false;
        return true;
      });
      return json({
        hits: hits.slice(0, size).map((l) => ({ _id: String(l.id), _source: { fullName: l.fullName, brandName: l.brandName, upcSku: l.upcSku, offMarket: l.offMarket, entryDate: l.entryDate } })),
        stats: { count: hits.length },
      });
    }
    return json({ error: 'unknown path' }, 404);
  };
}
