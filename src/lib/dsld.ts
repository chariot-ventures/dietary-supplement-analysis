/**
 * NIH Dietary Supplement Label Database (DSLD) v9 client.
 *
 * Ported from SuppleTracker's dsld-search / getSuppFromDsldUsingId, with the
 * fixes PLAN.md section 2 calls for: encoded query params, server-side
 * on-market filter, capped result counts, a concurrency limit, a per-request
 * deadline, one retry on network errors, and LRU caching with stale fallback.
 */
import { LRUCache } from 'lru-cache';
import { AppError } from './errors.js';
import { todayIso } from './text.js';

// ---------- raw DSLD shapes (only the fields this service reads) ----------

export interface DsldQuantity {
  servingSizeOrder?: number;
  servingSizeQuantity?: number | null;
  servingSizeUnit?: string | null;
  operator?: string | null;
  quantity?: number | null;
  unit?: string | null;
  dailyValueTargetGroup?: { name?: string; operator?: string | null; percent?: number | null; footnote?: string | null }[];
}

export interface DsldForm {
  name: string;
  ingredientGroup?: string | null;
  uniiCode?: string | null;
}

export interface DsldIngredientRow {
  order?: number;
  name: string;
  category?: string | null;
  ingredientGroup?: string | null;
  uniiCode?: string | null;
  notes?: string | null;
  alternateNames?: string[] | null;
  forms?: DsldForm[] | null;
  quantity?: DsldQuantity[] | null;
  nestedRows?: DsldIngredientRow[] | null;
}

export interface DsldServingSize {
  order?: number;
  minQuantity?: number | null;
  maxQuantity?: number | null;
  minDailyServings?: number | null;
  maxDailyServings?: number | null;
  unit?: string | null;
  notes?: string | null;
}

export interface DsldLabel {
  id: number;
  fullName?: string | null;
  brandName?: string | null;
  upcSku?: string | null;
  offMarket?: number | null;
  productType?: { langualCodeDescription?: string | null } | null;
  servingSizes?: DsldServingSize[] | null;
  ingredientRows?: DsldIngredientRow[] | null;
  statements?: { type?: string | null; notes?: string | null }[] | null;
}

export interface DsldSearchHit {
  _id: string;
  _source?: { fullName?: string; brandName?: string; upcSku?: string; offMarket?: number } & Record<string, unknown>;
}

export interface SearchParams {
  query?: string;
  brand?: string;
  ingredient?: string;
  onMarketOnly: boolean;
  size: number;
}

export interface SearchResult {
  total: number;
  ids: number[];
  retrieved: string;
}

export interface LabelResult {
  label: DsldLabel;
  retrieved: string;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface DsldClientOptions {
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: FetchLike;
  requestDeadlineMs?: number;
  concurrency?: number;
  labelTtlMs?: number;
  searchTtlMs?: number;
  maxLabels?: number;
  maxSearches?: number;
}

export const DSLD_BASE_URL = 'https://api.ods.od.nih.gov/dsld/v9';
export const dsldLabelUrl = (id: number) => `https://dsld.od.nih.gov/label/${id}`;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Minimal FIFO semaphore so a burst of label fetches never exceeds `limit` in flight. */
export class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

class UpstreamHttpError extends Error {
  constructor(readonly status: number) {
    super(`DSLD responded with HTTP ${status}`);
  }
}

interface Cached<T> {
  value: T;
  retrieved: string;
}

export class DsldClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly deadlineMs: number;
  private readonly sem: Semaphore;
  private readonly labels: LRUCache<number, Cached<DsldLabel>>;
  private readonly searches: LRUCache<string, Cached<{ total: number; ids: number[] }>>;
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(opts: DsldClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DSLD_BASE_URL).replace(/\/+$/, '');
    this.apiKey = opts.apiKey || undefined;
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.deadlineMs = opts.requestDeadlineMs ?? 6000;
    this.sem = new Semaphore(opts.concurrency ?? 4);
    const cacheOpts = { allowStale: false, noDeleteOnStaleGet: true } as const;
    this.labels = new LRUCache({ max: opts.maxLabels ?? 5000, ttl: opts.labelTtlMs ?? 7 * DAY_MS, ...cacheOpts });
    this.searches = new LRUCache({ max: opts.maxSearches ?? 1000, ttl: opts.searchTtlMs ?? DAY_MS, ...cacheOpts });
  }

  async getLabel(id: number): Promise<LabelResult> {
    const fresh = this.labels.get(id);
    if (fresh) return { label: fresh.value, retrieved: fresh.retrieved };

    return this.dedupe(`label:${id}`, async () => {
      try {
        const body = await this.getJson(`/label/${encodeURIComponent(String(id))}`);
        const label = asLabel(body);
        if (!label) throw new AppError('NOT_FOUND', `No DSLD label with id ${id}`, { field: 'dsld_id' });
        const entry = { value: label, retrieved: todayIso() };
        this.labels.set(id, entry);
        return { label, retrieved: entry.retrieved };
      } catch (err) {
        if (err instanceof UpstreamHttpError && err.status === 404) {
          throw new AppError('NOT_FOUND', `No DSLD label with id ${id}`, { field: 'dsld_id' });
        }
        if (err instanceof AppError) throw err;
        const stale = this.labels.get(id, { allowStale: true });
        if (stale) return { label: stale.value, retrieved: stale.retrieved };
        throw upstreamUnavailable(err);
      }
    });
  }

  /** Fetch several labels with the shared concurrency limit. Rejects on the first NOT_FOUND / upstream error. */
  async getLabels(ids: number[]): Promise<LabelResult[]> {
    return Promise.all(ids.map((id) => this.getLabel(id)));
  }

  async search(p: SearchParams): Promise<SearchResult> {
    const params = new URLSearchParams();
    if (p.query) params.set('q', p.query);
    if (p.brand) params.set('brand', p.brand);
    if (p.ingredient) params.set('ingredient_name', p.ingredient);
    params.set('status', p.onMarketOnly ? '1' : '2');
    params.set('size', String(p.size));
    params.set('from', '0');
    const key = params.toString();

    const fresh = this.searches.get(key);
    if (fresh) return { ...fresh.value, retrieved: fresh.retrieved };

    return this.dedupe(`search:${key}`, async () => {
      try {
        const body = await this.getJson(`/search-filter?${key}`);
        const parsed = parseSearch(body, p.onMarketOnly);
        const entry = { value: parsed, retrieved: todayIso() };
        this.searches.set(key, entry);
        return { ...parsed, retrieved: entry.retrieved };
      } catch (err) {
        const stale = this.searches.get(key, { allowStale: true });
        if (stale) return { ...stale.value, retrieved: stale.retrieved };
        throw upstreamUnavailable(err);
      }
    });
  }

  /** Seed the label cache (startup pre-warm, tests). */
  prime(label: DsldLabel, retrieved = todayIso()): void {
    this.labels.set(label.id, { value: label, retrieved });
  }

  private async dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;
    const p = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async getJson(pathAndQuery: string): Promise<unknown> {
    const url = `${this.baseUrl}${pathAndQuery}`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.apiKey) headers['X-Api-Key'] = this.apiKey;

    return this.sem.run(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(this.deadlineMs) });
          if (!res.ok) throw new UpstreamHttpError(res.status);
          return (await res.json()) as unknown;
        } catch (err) {
          const isAbort = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
          const isNetwork = err instanceof TypeError;
          if (attempt === 0 && isNetwork && !isAbort) continue;
          throw err;
        }
      }
    });
  }
}

function upstreamUnavailable(err: unknown): AppError {
  const detail =
    err instanceof UpstreamHttpError
      ? `HTTP ${err.status}`
      : err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
        ? 'no response within the deadline'
        : 'network error';
  return new AppError('UPSTREAM_UNAVAILABLE', `NIH DSLD could not be reached (${detail}) and no cached copy is available. Retry shortly.`, {
    retryable: true,
  });
}

function asLabel(body: unknown): DsldLabel | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const id = typeof b.id === 'number' ? b.id : typeof b.id === 'string' && /^\d+$/.test(b.id) ? Number(b.id) : null;
  if (id === null || (!b.fullName && !Array.isArray(b.ingredientRows))) return null;
  return { ...(b as unknown as DsldLabel), id };
}

function parseSearch(body: unknown, onMarketOnly: boolean): { total: number; ids: number[] } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const hits = (Array.isArray(b.hits) ? b.hits : []) as DsldSearchHit[];
  const ids: number[] = [];
  for (const h of hits) {
    const id = Number(h?._id);
    if (!Number.isInteger(id) || id <= 0) continue;
    if (onMarketOnly && h._source && typeof h._source.offMarket === 'number' && h._source.offMarket !== 0) continue;
    ids.push(id);
  }
  const stats = b.stats as { count?: unknown } | undefined;
  const totalObj = b.total as { value?: unknown } | number | undefined;
  const total =
    typeof stats?.count === 'number'
      ? stats.count
      : typeof totalObj === 'number'
        ? totalObj
        : typeof totalObj?.value === 'number'
          ? totalObj.value
          : ids.length;
  return { total, ids };
}
