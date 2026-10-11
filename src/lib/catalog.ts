/**
 * Product identification on top of DSLD search: collapsing label versions,
 * ranking hits against what a user typed, and UPC lookup.
 *
 * DSLD keeps every label version as its own record (Centrum Silver Women 50+
 * has several), so search results repeat the same product. Versions are
 * grouped by brand + product name; the newest on-market entry represents the
 * group and the rest are listed as other_versions.
 */
import { AppError } from './errors.js';
import { formatUpcForDsld, normalizeUpc, type CallOptions, type DsldClient, type SearchHit } from './dsld.js';
import { normalizeName } from './text.js';

export interface VersionGroup {
  primary: SearchHit;
  others: SearchHit[];
}

export function productKey(brand: string | null, name: string | null): string {
  return normalizeName(`${brand ?? ''} ${name ?? ''}`).replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Newer first: on-market before off-market, then later entry date, then higher DSLD ID. */
function newerFirst(a: SearchHit, b: SearchHit): number {
  const m = Number(b.on_market === true) - Number(a.on_market === true);
  if (m) return m;
  const d = (b.entry_date ?? '').localeCompare(a.entry_date ?? '');
  return d || b.id - a.id;
}

/** Group hits into products, keeping DSLD's relevance order of each product's first appearance. */
export function groupVersions(hits: SearchHit[]): VersionGroup[] {
  const groups = new Map<string, SearchHit[]>();
  for (const h of hits) {
    const key = h.name ? productKey(h.brand, h.name) : `id:${h.id}`;
    groups.set(key, [...(groups.get(key) ?? []), h]);
  }
  return [...groups.values()].map((list) => {
    const sorted = [...list].sort(newerFirst);
    return { primary: sorted[0]!, others: sorted.slice(1) };
  });
}

// ---------- matching a free-text product description ----------

const STOP = new Set(['the', 'and', 'with', 'for', 'of', 'a', 'an', 'plus', 'by', 'mg', 'mcg', 'iu', 'g', 'supplement', 'dietary']);

/** Words for matching: no punctuation or apostrophes ("Women's" = "womens"), simple plural folding ("womens" = "women"). */
export function tokens(text: string): string[] {
  return normalizeName(text)
    .replace(/['’]/g, '')
    .replace(/(\d)\s*\+/g, '$1')
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOP.has(t))
    .map((t) => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t));
}

/** Share of the query's words found in the product's brand and name (0-1). */
export function matchScore(query: string, hit: Pick<SearchHit, 'brand' | 'name'>): number {
  const q = [...new Set(tokens(query))];
  if (q.length === 0) return 0;
  const have = new Set(tokens(`${hit.brand ?? ''} ${hit.name ?? ''}`));
  return q.filter((t) => have.has(t)).length / q.length;
}

export type Confidence = 'high' | 'medium' | 'low';

export interface Candidate {
  dsld_id: number;
  brand: string | null;
  name: string | null;
  entry_date: string | null;
  on_market: boolean | null;
  score: number;
  other_versions: number[];
}

export interface QueryResolution {
  chosen: Candidate | null;
  confidence: Confidence | null;
  alternatives: Candidate[];
  reason: string;
}

const asCandidate = (g: VersionGroup, score: number): Candidate => ({
  dsld_id: g.primary.id,
  brand: g.primary.brand,
  name: g.primary.name,
  entry_date: g.primary.entry_date,
  on_market: g.primary.on_market,
  score: Math.round(score * 100) / 100,
  other_versions: g.others.map((o) => o.id),
});

/**
 * Pick the product a free-text description most likely means.
 * high: every word matched and no other product matched every word.
 * medium: every word matched but other products did too, or most words matched.
 * low: under 60% of the words matched (the alternatives are worth showing the user).
 */
export function rankCandidates(query: string, brand: string | undefined, hits: SearchHit[]): QueryResolution {
  const text = brand ? `${brand} ${query}` : query;
  const groups = groupVersions(hits);
  if (groups.length === 0) return { chosen: null, confidence: null, alternatives: [], reason: 'DSLD returned no products for this description' };
  const scored = groups.map((g, rank) => ({ g, rank, score: matchScore(text, g.primary) }));
  scored.sort((a, b) => b.score - a.score || a.rank - b.rank);
  const best = scored[0]!;
  const fullMatches = scored.filter((s) => s.score === 1).length;
  const confidence: Confidence = best.score === 1 ? (fullMatches === 1 ? 'high' : 'medium') : best.score >= 0.6 ? 'medium' : 'low';
  const reason =
    best.score === 1
      ? fullMatches === 1
        ? 'every word of the description matches this product'
        : `every word matches, but ${fullMatches - 1} other product(s) also match; picked the most relevant DSLD result`
      : `${Math.round(best.score * 100)}% of the description's words match this product`;
  return {
    chosen: asCandidate(best.g, best.score),
    confidence,
    alternatives: scored.slice(1, 4).map((s) => asCandidate(s.g, s.score)),
    reason,
  };
}

export async function resolveQuery(dsld: DsldClient, query: string, brand: string | undefined, opts: CallOptions): Promise<QueryResolution> {
  const result = await dsld.search({ query, brand, onMarketOnly: false, size: 15 }, opts);
  return rankCandidates(query, brand, result.hits);
}

// ---------- UPC ----------

export interface UpcMatch {
  upc: string;
  versions: SearchHit[];
}

/** Find DSLD labels whose UPC matches; newest version first. Throws NOT_FOUND when none do. */
export async function lookupUpc(dsld: DsldClient, raw: string, opts: CallOptions, field = 'upc'): Promise<UpcMatch> {
  const digits = normalizeUpc(raw);
  if (digits.length < 8 || digits.length > 14) {
    throw new AppError('INVALID_INPUT', `${field}: a UPC/EAN barcode has 8-14 digits; got ${digits.length}`, { field });
  }
  const phrase = formatUpcForDsld(digits) ?? digits;
  const result = await dsld.search({ query: `"${phrase}"`, onMarketOnly: false, size: 10 }, opts);
  let hits = result.hits;
  // The search index may not return upcSku; confirm against the labels themselves when it doesn't.
  if (hits.some((h) => h.upc === null)) {
    const labels = await Promise.all(hits.slice(0, 5).map((h) => dsld.getLabel(h.id, opts).then((l) => l.label).catch(() => null)));
    hits = hits.slice(0, 5).map((h, i) => ({ ...h, upc: h.upc ?? labels[i]?.upcSku ?? null, entry_date: h.entry_date ?? labels[i]?.entryDate ?? null }));
  }
  const versions = hits.filter((h) => h.upc !== null && normalizeUpc(h.upc) === digits).sort(newerFirst);
  if (versions.length === 0) throw new AppError('NOT_FOUND', `No DSLD label has UPC ${digits}`, { field });
  return { upc: digits, versions };
}
