/**
 * Persistent local copy of DSLD labels (SQLite, via Node's built-in node:sqlite).
 *
 * Every label the service fetches is kept here, and a background warmer adds
 * popular products. The store makes the service:
 *   - survive restarts with its cache intact,
 *   - answer label, barcode and search requests when NIH's API is slow or down,
 *   - look up barcodes without a round trip for products it already holds.
 * NIH stays the source of truth: labels older than `freshDays` are re-fetched
 * when the API is reachable, and live search results are preferred.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { DsldLabel, SearchHit } from './dsld.js';
import { normalizeUpc } from './dsld.js';
import { normalizeName } from './text.js';

// node:sqlite is loaded lazily so the service still runs where it's unavailable.
type Db = {
  exec(sql: string): void;
  prepare(sql: string): { run(...a: unknown[]): unknown; get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] };
  close(): void;
};

export interface StoredLabel {
  label: DsldLabel;
  retrieved: string;
}

export interface LocalSearch {
  total: number;
  hits: SearchHit[];
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS labels (
    id INTEGER PRIMARY KEY,
    json TEXT NOT NULL,
    retrieved TEXT NOT NULL,
    brand TEXT,
    name TEXT,
    upc TEXT,
    upc_digits TEXT,
    entry_date TEXT,
    off_market INTEGER
  );
  CREATE INDEX IF NOT EXISTS labels_upc ON labels(upc_digits);
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  CREATE VIRTUAL TABLE IF NOT EXISTS labels_fts USING fts5(brand, name, ingredients, tokenize = 'unicode61 remove_diacritics 2');
`;

function ingredientText(l: DsldLabel): string {
  const names: string[] = [];
  const walk = (rows: DsldLabel['ingredientRows']) => {
    for (const r of rows ?? []) {
      if (!r?.name) continue;
      names.push(r.name, ...(r.forms ?? []).map((f) => f.name));
      walk(r.nestedRows);
    }
  };
  walk(l.ingredientRows);
  return names.join(' ');
}

/** FTS5 query from free text: each word as a quoted prefix term, all required. */
export function ftsQuery(text: string): string | null {
  const words = normalizeName(text)
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0)
    .slice(0, 12);
  return words.length ? words.map((w) => `"${w}"*`).join(' AND ') : null;
}

export class LabelStore {
  private readonly put: ReturnType<Db['prepare']>;
  private readonly putFtsDelete: ReturnType<Db['prepare']>;
  private readonly putFts: ReturnType<Db['prepare']>;
  private readonly get: ReturnType<Db['prepare']>;
  private readonly byUpc: ReturnType<Db['prepare']>;

  constructor(private readonly db: Db) {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
    db.exec(SCHEMA);
    this.put = db.prepare(
      'INSERT INTO labels (id, json, retrieved, brand, name, upc, upc_digits, entry_date, off_market) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET json = excluded.json, retrieved = excluded.retrieved, brand = excluded.brand, name = excluded.name, ' +
        'upc = excluded.upc, upc_digits = excluded.upc_digits, entry_date = excluded.entry_date, off_market = excluded.off_market',
    );
    this.putFtsDelete = db.prepare('DELETE FROM labels_fts WHERE rowid = ?');
    this.putFts = db.prepare('INSERT INTO labels_fts (rowid, brand, name, ingredients) VALUES (?, ?, ?, ?)');
    this.get = db.prepare('SELECT json, retrieved FROM labels WHERE id = ?');
    this.byUpc = db.prepare('SELECT id, brand, name, upc, entry_date, off_market FROM labels WHERE upc_digits = ?');
  }

  getLabel(id: number): StoredLabel | null {
    const row = this.get.get(id) as { json: string; retrieved: string } | undefined;
    return row ? { label: JSON.parse(row.json) as DsldLabel, retrieved: row.retrieved } : null;
  }

  putLabel(label: DsldLabel, retrieved: string): void {
    const upc = label.upcSku ?? null;
    this.put.run(
      label.id,
      JSON.stringify(label),
      retrieved,
      label.brandName ?? null,
      label.fullName ?? null,
      upc,
      upc ? normalizeUpc(upc) : null,
      label.entryDate ?? null,
      typeof label.offMarket === 'number' ? label.offMarket : null,
    );
    this.putFtsDelete.run(label.id);
    this.putFts.run(label.id, label.brandName ?? '', label.fullName ?? '', ingredientText(label));
  }

  getMeta(k: string): string | null {
    return (this.db.prepare('SELECT v FROM meta WHERE k = ?').get(k) as { v: string } | undefined)?.v ?? null;
  }

  setMeta(k: string, v: string): void {
    this.db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v').run(k, v);
  }

  /** Several writes in one transaction (bulk import). */
  transaction(fn: () => void): void {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  findUpc(digits: string): SearchHit[] {
    return (this.byUpc.all(digits) as { id: number; brand: string | null; name: string | null; upc: string | null; entry_date: string | null; off_market: number | null }[]).map(toHit);
  }

  search(p: { query?: string | undefined; brand?: string | undefined; ingredient?: string | undefined; onMarketOnly: boolean; size: number }): LocalSearch {
    const parts: string[] = [];
    const q = p.query ? ftsQuery(p.query) : null;
    if (q) parts.push(`(${q})`);
    const b = p.brand ? ftsQuery(p.brand) : null;
    if (b) parts.push(`brand : (${b})`);
    const ing = p.ingredient ? ftsQuery(p.ingredient) : null;
    if (ing) parts.push(`ingredients : (${ing})`);
    if (parts.length === 0) return { total: 0, hits: [] };
    const where = `labels_fts MATCH ?${p.onMarketOnly ? ' AND (l.off_market = 0 OR l.off_market IS NULL)' : ''}`;
    const match = parts.join(' AND ');
    const total = (this.db.prepare(`SELECT count(*) AS n FROM labels_fts JOIN labels l ON l.id = labels_fts.rowid WHERE ${where}`).get(match) as { n: number }).n;
    const rows = this.db
      .prepare(`SELECT l.id, l.brand, l.name, l.upc, l.entry_date, l.off_market FROM labels_fts JOIN labels l ON l.id = labels_fts.rowid WHERE ${where} ORDER BY bm25(labels_fts, 4.0, 10.0, 1.0) LIMIT ?`)
      .all(match, p.size) as Parameters<typeof toHit>[0][];
    return { total, hits: rows.map(toHit) };
  }

  count(): number {
    return (this.db.prepare('SELECT count(*) AS n FROM labels').get() as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }
}

function toHit(r: { id: number; brand: string | null; name: string | null; upc: string | null; entry_date: string | null; off_market: number | null }): SearchHit {
  return { id: r.id, brand: r.brand, name: r.name, upc: r.upc, entry_date: r.entry_date, on_market: r.off_market === null ? null : r.off_market === 0 };
}

/** Open (or create) the store; returns null with a reason when SQLite is unavailable or the path isn't writable. */
export async function openLabelStore(file: string): Promise<{ store: LabelStore | null; error?: string }> {
  try {
    const { DatabaseSync } = (await import('node:sqlite')) as unknown as { DatabaseSync: new (p: string) => Db };
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    return { store: new LabelStore(new DatabaseSync(file)) };
  } catch (err) {
    return { store: null, error: err instanceof Error ? err.message : String(err) };
  }
}
