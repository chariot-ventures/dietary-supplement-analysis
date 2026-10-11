/**
 * FDA recalls (food enforcement reports, which include dietary supplements)
 * and CAERS adverse event reports, via openFDA.
 *
 * Matching is strict: a recall matches a product when its description carries
 * the product's barcode, or the brand plus every distinctive word of the
 * product name. Recalls that only mention the brand are counted, not listed.
 * Adverse event reports are counted for the brand and product words; a report
 * does not show that a product caused the event (openFDA's own disclaimer).
 */
import { LRUCache } from 'lru-cache';
import { normalizeName } from './text.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const OPENFDA_BASE_URL = 'https://api.fda.gov';
export const CAERS_DISCLAIMER =
  'An adverse event report does not show that the product caused the event; FDA does not verify reports, and counts cannot be used to estimate how often events happen.';

export interface ProductKey {
  brand: string;
  name: string;
  /** 12-digit UPC-A, when known. */
  upc: string | null;
}

export interface Recall {
  recall_number: string;
  classification: string | null;
  status: string | null;
  reason_for_recall: string | null;
  product_description: string;
  recalling_firm: string | null;
  recall_initiation_date: string | null;
  report_date: string | null;
  matched_by: 'upc' | 'brand_and_name';
}

export interface FdaReport {
  recalls: { matched: Recall[]; brand_recalls_total: number; last_updated: string | null; search_url: string };
  adverse_events: {
    scope: 'product' | 'brand' | 'none';
    /** Reports whose product list names this brand (and, for scope "product", every name word). */
    total: number;
    top_reactions: { term: string; count: number }[];
    last_updated: string | null;
    search_url: string;
  };
  unavailable: string[];
}

const GENERIC_WORDS = new Set(
  'a an and with the of for plus vitamin vitamins dietary supplement supplements formula tablet tablets capsule capsules softgel softgels gummy gummies caplet caplets vegetarian veggie count ct mg mcg iu g ml liquid chewable chewables extra strength value size pack bottle'.split(' '),
);

/** Lowercase words with letters and digits split ("1000IU" -> "1000 iu"). */
export function words(s: string): string[] {
  return normalizeName(s)
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .split(' ')
    .filter(Boolean);
}

/** Words of the product name that identify it: no brand words, units or dosage forms. */
export function distinctiveWords(key: ProductKey): string[] {
  const brand = new Set(words(key.brand));
  return [...new Set(words(key.name).filter((w) => !brand.has(w) && !GENERIC_WORDS.has(w)))];
}

/** Manufacturer and item digits of a UPC-A (drops the number-system and check digits, which recalls often format differently). */
const upcCore = (upc: string) => (/^\d{12}$/.test(upc) ? upc.slice(1, 11) : null);

export function matchRecall(desc: string, key: ProductKey): Recall['matched_by'] | null {
  const core = key.upc ? upcCore(key.upc) : null;
  if (core && desc.replace(/[\s-]/g, '').includes(core)) return 'upc';
  const d = new Set(words(desc));
  const brand = words(key.brand);
  const name = distinctiveWords(key);
  if (brand.length && brand.every((w) => d.has(w)) && name.length && name.every((w) => d.has(w))) return 'brand_and_name';
  return null;
}

const phrase = (field: string, text: string) => `${field}:"${text.replace(/["\\]/g, ' ').trim()}"`;

export class OpenFdaClient {
  private readonly cache = new LRUCache<string, object>({ max: 2000, ttl: 24 * 3600 * 1000 });
  constructor(
    private readonly fetchImpl: FetchLike = (u, i) => fetch(u, i),
    private readonly base = OPENFDA_BASE_URL,
    private readonly apiKey?: string,
  ) {}

  /** JSON body, {} for "no matches" (openFDA answers 404), or null when openFDA can't be reached. */
  private async get(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
    const qs = new URLSearchParams(params);
    if (this.apiKey) qs.set('api_key', this.apiKey);
    const key = `${path}?${new URLSearchParams(params)}`;
    const hit = this.cache.get(key);
    if (hit) return hit as Record<string, unknown>;
    try {
      const timeout = AbortSignal.timeout(5000);
      const res = await this.fetchImpl(`${this.base}${path}?${qs}`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (res.status === 404) return this.remember(key, {});
      if (!res.ok) return null;
      return this.remember(key, (await res.json()) as Record<string, unknown>);
    } catch {
      return null;
    }
  }

  private remember(key: string, v: Record<string, unknown>) {
    this.cache.set(key, v);
    return v;
  }

  publicUrl(path: string, params: Record<string, string>): string {
    return `${this.base}${path}?${new URLSearchParams(params)}`;
  }

  async report(key: ProductKey, signal?: AbortSignal): Promise<FdaReport> {
    const unavailable: string[] = [];
    const brandQ = phrase('product_description', key.brand);
    const recallParams = { search: brandQ, limit: '100', sort: 'report_date:desc' };
    const name = distinctiveWords(key);
    const productQ = [phrase('products.name_brand', key.brand), ...name.map((w) => `products.name_brand:${w}`)].join(' AND ');
    const brandEventQ = phrase('products.name_brand', key.brand);

    const [recallBody, productEvents, productTop, brandEvents] = await Promise.all([
      this.get('/food/enforcement.json', recallParams, signal),
      name.length ? this.get('/food/event.json', { search: productQ, limit: '1' }, signal) : Promise.resolve<Record<string, unknown>>({}),
      name.length ? this.get('/food/event.json', { search: productQ, count: 'reactions.exact' }, signal) : Promise.resolve<Record<string, unknown>>({}),
      this.get('/food/event.json', { search: brandEventQ, limit: '1' }, signal),
    ]);

    const meta = (b: Record<string, unknown> | null) => (b?.meta ?? {}) as { last_updated?: string; results?: { total?: number } };
    if (recallBody === null) unavailable.push('recalls');
    const rows = ((recallBody?.results ?? []) as Record<string, string | undefined>[]).filter((r) => typeof r.product_description === 'string');
    const matched: Recall[] = [];
    for (const r of rows) {
      const by = matchRecall(r.product_description!, key);
      if (!by) continue;
      matched.push({
        recall_number: r.recall_number ?? '',
        classification: r.classification ?? null,
        status: r.status ?? null,
        reason_for_recall: r.reason_for_recall ?? null,
        product_description: r.product_description!.length > 400 ? `${r.product_description!.slice(0, 400)}...` : r.product_description!,
        recalling_firm: r.recalling_firm ?? null,
        recall_initiation_date: isoDate(r.recall_initiation_date),
        report_date: isoDate(r.report_date),
        matched_by: by,
      });
    }

    if (productEvents === null || brandEvents === null) unavailable.push('adverse_events');
    const productTotal = meta(productEvents).results?.total ?? 0;
    const brandTotal = meta(brandEvents).results?.total ?? 0;
    const scope: FdaReport['adverse_events']['scope'] = productTotal > 0 ? 'product' : brandTotal > 0 ? 'brand' : 'none';
    let top: { term: string; count: number }[] = [];
    if (scope === 'product') {
      top = ((productTop?.results ?? []) as { term?: string; count?: number }[]).slice(0, 8).map((x) => ({ term: String(x.term ?? '').toLowerCase(), count: Number(x.count ?? 0) }));
    }

    return {
      recalls: {
        matched,
        brand_recalls_total: meta(recallBody).results?.total ?? 0,
        last_updated: meta(recallBody).last_updated ?? null,
        search_url: this.publicUrl('/food/enforcement.json', { search: brandQ, limit: '100' }),
      },
      adverse_events: {
        scope,
        total: scope === 'product' ? productTotal : brandTotal,
        top_reactions: top,
        last_updated: meta(scope === 'product' ? productEvents : brandEvents).last_updated ?? null,
        search_url: this.publicUrl('/food/event.json', { search: scope === 'product' ? productQ : brandEventQ, limit: '100' }),
      },
      unavailable,
    };
  }
}

function isoDate(d: string | undefined): string | null {
  return d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null;
}
