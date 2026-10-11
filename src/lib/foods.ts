/**
 * Foods a person eats, from USDA SR28 (data/foods.json, built by
 * scripts/build-foods.ts). Offline: no API key and no network call.
 *
 * Matching is by whole words: every word of the query (singular or plural)
 * must appear in the USDA description; among those, the description with the
 * fewest extra words wins, and the rest are offered as alternatives.
 * Amounts are grams, or a count of one of the food's USDA household portions
 * ("1 cup", "1 large"), or a weight unit (oz, lb, kg). A portion the food
 * doesn't list is reported, not guessed.
 */
import data from '../../data/foods.json' with { type: 'json' };
import type { Amount } from './label.js';
import { nutrientIndex } from './nutrients.js';
import { round } from './text.js';

type FoodRow = [string, string, (number | null)[], (number | null)[], [number, string][]];
interface FoodsFile {
  source: { name: string; url: string; retrieved: string };
  nutrients: string[];
  /** SR28 values excluded as implausible, by NDB number. */
  suspect: Record<string, { nutrient: string; why: string }[]>;
  foods: FoodRow[];
}
const file = data as unknown as FoodsFile;
export const FOODS_SOURCE = file.source;
export const FOOD_NUTRIENTS = file.nutrients;

const STOP = new Set(['a', 'an', 'of', 'the', 'and', 'or', 'in', 'my', 'some', 'fresh']);

export function foodWords(s: string): string[] {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, ' ')
    .split(' ')
    .filter((w) => w && !STOP.has(w));
}

/** Singular form for matching: "eggs" -> "egg", "berries" -> "berry", "tomatoes" -> "tomato". */
function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith('oes')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** Category heads and default qualifiers in USDA descriptions that don't make a food a different food. */
const NEUTRAL = new Set(
  'nuts fish beverages cereals spices seeds beef pork lamb veal chicken turkey cheese milk whole raw fresh plain regular fluid all varieties commercial prepared unprepared ready to serve eat brewed with without salt tap water'
    .split(' ')
    .map((w) => stem(w)),
);
/** Regional variants rank below the default food unless asked for. */
const REGIONAL = /new zealand|imported|australian|alaska native|northern plains indians|hispanic|navajo|apache|shoshone|hopi/i;

interface Indexed {
  row: FoodRow;
  words: Set<string>;
  /** Words of the first and second comma-separated parts ("Spinach", "cooked"). */
  seg1: string[];
  seg2: string[];
  all: string[];
  baby: boolean;
  regional: boolean;
  /** Brand-name item (an all-caps word such as KEEBLER). */
  brand: boolean;
}
const INDEX: Indexed[] = file.foods.map((row) => {
  const segs = row[1].split(',').map((x) => foodWords(x).map(stem));
  const all = segs.flat();
  return { row, words: new Set(all), seg1: segs[0] ?? [], seg2: segs[1] ?? [], all, baby: /^babyfood/i.test(row[1]), regional: REGIONAL.test(row[1]), brand: /\b[A-Z]{3,}\b/.test(row[1]) };
});
const VOCAB = new Set(INDEX.flatMap((f) => f.all));
const BY_NDB = new Map(file.foods.map((r) => [r[0], r]));

export interface FoodCandidate {
  ndb_number: string;
  description: string;
}

export type FoodConfidence = 'high' | 'medium';

/** Query word lists to try: as given, and with adjacent words joined when USDA writes them as one ("brazil nuts" -> "brazilnut"). */
function variants(q: string[]): string[][] {
  const out = [q];
  for (let i = 0; i + 1 < q.length; i++) {
    const joined = stem(`${q[i]}${q[i + 1]}`);
    if (VOCAB.has(joined)) out.push([...q.slice(0, i), joined, ...q.slice(i + 2)]);
  }
  return out;
}

type Key = [number, number, number, number, number];
function rankKey(f: Indexed, q: Set<string>, rawQuery: string): Key {
  const extra = (ws: string[]) => ws.filter((w) => !q.has(w) && !NEUTRAL.has(w)).length;
  const penalty =
    (f.baby && !q.has('babyfood') && !q.has('baby') ? 2 : 0) + (f.brand && !/[A-Z]{3,}/.test(rawQuery) ? 1 : 0) + (f.regional && !REGIONAL.test(rawQuery) ? 1 : 0);
  // Last tie-break: USDA's unsalted default over "with salt", then the shorter description.
  const salted = /\bwith salt\b/i.test(f.row[1]) && !q.has('salt') && !q.has('salted') ? 1000 : 0;
  return [penalty, extra(f.seg1), extra(f.seg2), extra(f.all), salted + f.row[1].length];
}
const cmp = (a: Key, b: Key) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3] || a[4] - b[4];

/** Foods whose description contains every query word, best first. */
export function searchFoods(query: string, limit = 5): { matches: FoodCandidate[]; confidence: FoodConfidence | null } {
  const base = [...new Set(foodWords(query).map(stem))];
  if (!base.length) return { matches: [], confidence: null };
  const scored = new Map<string, { f: Indexed; key: Key }>();
  for (const q of variants(base)) {
    const qs = new Set(q);
    for (const f of INDEX) {
      if (!q.every((w) => f.words.has(w))) continue;
      const key = rankKey(f, qs, query);
      const prev = scored.get(f.row[0]);
      if (!prev || cmp(key, prev.key) < 0) scored.set(f.row[0], { f, key });
    }
  }
  const hits = [...scored.values()].sort((a, b) => cmp(a.key, b.key)).slice(0, limit);
  if (!hits.length) return { matches: [], confidence: null };
  const [best, next] = hits;
  const clean = best!.key[0] === 0 && best!.key[1] === 0 && best!.key[2] === 0;
  const tied = next !== undefined && next.key[0] === best!.key[0] && next.key[1] === best!.key[1] && next.key[2] === best!.key[2] && next.key[3] === best!.key[3];
  return { matches: hits.map((h) => ({ ndb_number: h.f.row[0], description: h.f.row[1] })), confidence: clean && !tied ? 'high' : 'medium' };
}

export function getFood(ndb: string): FoodRow | undefined {
  return BY_NDB.get(ndb.replace(/^0+(?=\d{5}$)/, '').padStart(5, '0'));
}

const UNIT_ALIASES: Record<string, string> = {
  cups: 'cup',
  tablespoon: 'tbsp',
  tablespoons: 'tbsp',
  tbs: 'tbsp',
  teaspoon: 'tsp',
  teaspoons: 'tsp',
  slices: 'slice',
  pieces: 'piece',
  pc: 'piece',
  eggs: 'egg',
  fl_oz: 'fl oz',
  'fluid ounce': 'fl oz',
  'fluid ounces': 'fl oz',
  ounce: 'oz',
  ounces: 'oz',
  pound: 'lb',
  pounds: 'lb',
  lbs: 'lb',
  gram: 'g',
  grams: 'g',
  kilogram: 'kg',
  kilograms: 'kg',
  serving: 'serving',
  servings: 'serving',
};
const WEIGHT_G: Record<string, number> = { g: 1, kg: 1000, oz: 28.3495, lb: 453.592 };

const normUnit = (u: string) => {
  const s = u.trim().toLowerCase().replace(/\.$/, '');
  return UNIT_ALIASES[s] ?? s;
};

/** "1 cup, chopped" -> {count: 1, unit: "cup"}; ".5 cup" -> 0.5. */
function parsePortion(desc: string): { count: number; unit: string } | null {
  const m = desc.trim().match(/^(\d*\.?\d+)\s+(fl oz|[a-z]+)/i);
  if (!m) return null;
  return { count: Number(m[1]), unit: normUnit(m[2]!) };
}

export type PortionResult = { ok: true; grams: number; portion: string | null } | { ok: false; reason: string; portions: string[] };

/** Grams for an amount of a food: grams directly, a weight unit, or one of its USDA household portions. */
export function gramsFor(row: FoodRow, amount: number, unit: string): PortionResult {
  const u = normUnit(unit);
  if (WEIGHT_G[u] !== undefined) return { ok: true, grams: round(amount * WEIGHT_G[u]!, 2), portion: null };
  for (const [grams, desc] of row[4]) {
    const p = parsePortion(desc);
    if (p && p.unit === u && p.count > 0) return { ok: true, grams: round((amount / p.count) * grams, 2), portion: desc };
  }
  return { ok: false, reason: `USDA lists no "${unit}" portion for this food`, portions: row[4].map(([g, d]) => `${d} (${g} g)`) };
}

export interface FoodNutrient {
  nutrient_id: string;
  amount: number;
  /** Part that counts toward the UL; null when it can't be separated (fortificants) or wasn't analyzed. */
  toward_ul: number | null;
  unit: string;
}

/** Nutrients in a given weight of a food; nutrients USDA didn't analyze for it are listed separately. */
export function nutrientsIn(row: FoodRow, grams: number): { nutrients: FoodNutrient[]; not_analyzed: string[]; suspect: { nutrient: string; why: string }[] } {
  const nutrients: FoodNutrient[] = [];
  const notAnalyzed: string[] = [];
  file.nutrients.forEach((id, i) => {
    const per100 = row[2][i];
    if (per100 === null || per100 === undefined) {
      notAnalyzed.push(id);
      return;
    }
    const toward = row[3][i];
    nutrients.push({
      nutrient_id: id,
      amount: round((per100 * grams) / 100, 4),
      toward_ul: toward === null || toward === undefined ? null : round((toward * grams) / 100, 4),
      unit: nutrientIndex.get(id)?.canonical_unit ?? '',
    });
  });
  const suspect = file.suspect[row[0]] ?? [];
  return { nutrients, not_analyzed: notAnalyzed.filter((id) => !suspect.some((s) => s.nutrient === id)), suspect };
}

export const foodSourceUrl = (ndb: string) => `https://fdc.nal.usda.gov/food-search?query=${encodeURIComponent(ndb)}&type=SR%20Legacy`;

export type { Amount };

// ---------- Foods in a stack_analyze request ----------

export interface FoodInput {
  query?: string | undefined;
  ndb_number?: string | undefined;
  grams?: number | undefined;
  amount?: number | undefined;
  unit?: string | undefined;
}

export interface FoodItemResult {
  input_path: string;
  input: FoodInput;
  status: 'resolved' | 'not_found' | 'portion_unknown';
  ndb_number: string | null;
  description: string | null;
  confidence: FoodConfidence | null;
  grams: number | null;
  /** The USDA household portion used to convert the amount, if any. */
  portion: string | null;
  alternatives: FoodCandidate[];
  /** Portions USDA lists for this food (status portion_unknown only). */
  portions?: string[];
  /** Nutrients USDA did not analyze for this food; their food totals are lower bounds. */
  not_analyzed: string[];
  /** SR28 values excluded as implausible (not counted). */
  data_suspect?: { nutrient: string; why: string }[];
}

export interface FoodTotal {
  nutrient_id: string;
  name: string;
  amount: number;
  unit: string;
  /** Part counting toward the UL; null when it can't be separated or a food lacks the analysis. */
  toward_ul: number | null;
  /** False when some listed food has no USDA analysis for this nutrient. */
  complete: boolean;
  /** Food alone, against the UL (only for nutrients the supplements don't supply). */
  percent_of_ul?: number | null;
  flags?: ('above_ul' | 'near_ul')[];
}

export function resolveFoods(inputs: FoodInput[]): { items: FoodItemResult[]; totals: FoodTotal[] } {
  const items: FoodItemResult[] = [];
  const sums = new Map<string, { amount: number; toward: number | null; unit: string; complete: boolean }>();
  inputs.forEach((input, i) => {
    const path = `foods.${i}`;
    let row: FoodRow | undefined;
    let alternatives: FoodCandidate[] = [];
    let confidence: FoodConfidence | null;
    if (input.ndb_number) {
      row = getFood(input.ndb_number);
      confidence = row ? 'high' : null;
    } else {
      const s = searchFoods(input.query ?? '', 4);
      row = s.matches[0] ? getFood(s.matches[0].ndb_number) : undefined;
      alternatives = s.matches.slice(1);
      confidence = s.confidence;
    }
    const base = { input_path: path, input, alternatives, not_analyzed: [] as string[] };
    if (!row) {
      items.push({ ...base, status: 'not_found', ndb_number: null, description: null, confidence: null, grams: null, portion: null });
      return;
    }
    const g = input.grams !== undefined ? ({ ok: true, grams: input.grams, portion: null } as const) : gramsFor(row, input.amount!, input.unit!);
    if (!g.ok) {
      items.push({ ...base, status: 'portion_unknown', ndb_number: row[0], description: row[1], confidence, grams: null, portion: null, portions: g.portions });
      return;
    }
    const n = nutrientsIn(row, g.grams);
    items.push({ ...base, status: 'resolved', ndb_number: row[0], description: row[1], confidence, grams: g.grams, portion: g.portion, not_analyzed: n.not_analyzed, ...(n.suspect.length ? { data_suspect: n.suspect } : {}) });
    for (const x of n.nutrients) {
      const cur = sums.get(x.nutrient_id) ?? { amount: 0, toward: 0, unit: x.unit, complete: true };
      cur.amount += x.amount;
      cur.toward = cur.toward === null || x.toward_ul === null ? null : cur.toward + x.toward_ul;
      sums.set(x.nutrient_id, cur);
    }
    for (const id of [...n.not_analyzed, ...n.suspect.map((s) => s.nutrient)]) {
      const cur = sums.get(id) ?? { amount: 0, toward: 0, unit: nutrientIndex.get(id)?.canonical_unit ?? '', complete: true };
      cur.complete = false;
      sums.set(id, cur);
    }
  });
  const totals: FoodTotal[] = [...sums]
    .filter(([, v]) => v.amount > 0 || !v.complete)
    .map(([id, v]) => ({ nutrient_id: id, name: nutrientIndex.get(id)?.name ?? id, amount: round(v.amount, 2), unit: v.unit, toward_ul: v.toward === null ? null : round(v.toward, 2), complete: v.complete }))
    .filter((t) => t.amount > 0);
  return { items, totals };
}
