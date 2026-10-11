/**
 * Medication and condition interactions, limited to those named in the NIH ODS
 * health-professional fact sheets (data/interactions.json). Not exhaustive, and
 * every finding cites its fact sheet.
 *
 * Medication names are matched against generic and brand names in the data
 * file. Names it doesn't know (misspellings, other brands) can be normalized to
 * their ingredient with NIH RxNorm (RxNav API), when the service can reach it.
 */
import data from '../../data/interactions.json' with { type: 'json' };
import type { StackAnalysis, StackProduct } from './analyze.js';
import { LRUCache } from 'lru-cache';
import { round } from './text.js';

interface DrugClass {
  name: string;
  members: string[];
}
interface Interaction {
  class: string;
  nutrients: string[];
  kind: string;
  summary: string;
  timing: string | null;
  source: { name: string; url: string };
}
interface ConditionCheck {
  nutrient: string;
  min_daily: { amount: number; unit: string };
  summary: string;
  source: { name: string; url: string };
}
interface InteractionsFile {
  reviewed: string;
  drug_classes: Record<string, DrugClass>;
  interactions: Interaction[];
  conditions: Record<string, { name: string; checks: ConditionCheck[] }>;
}
const file = data as unknown as InteractionsFile;

export const CONDITION_IDS = Object.keys(file.conditions) as [string, ...string[]];
export const INTERACTIONS_REVIEWED = file.reviewed;

export interface MedicationMatch {
  input: string;
  status: 'matched' | 'not_recognized';
  /** The generic or brand name that matched, or the RxNorm ingredient. */
  matched_name: string | null;
  via: 'name' | 'rxnorm' | null;
  classes: { id: string; name: string }[];
}

export interface InteractionFinding {
  type: 'medication' | 'condition';
  /** Medication input or condition id. */
  trigger: string;
  trigger_name: string;
  nutrient_ids: string[];
  /** True when the stack supplies one of the nutrients. */
  in_stack: boolean;
  product_refs: string[];
  kind: string;
  summary: string;
  timing: string | null;
  source: { name: string; url: string };
}

/** Lowercase, drop doses, strengths and punctuation: "Lisinopril 10 mg tab" -> "lisinopril tab". */
export function normalizeMedication(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[®™]/g, '')
    .replace(/\b\d+(\.\d+)?\s*(mg|mcg|g|ml|iu|units?|%)\b/g, ' ')
    .replace(/[^a-z0-9/\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const wordHit = (text: string, member: string) => new RegExp(`(^|[\\s/-])${member.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[\\s/-])`).test(text);

/** Classes whose generic or brand names appear (as whole words) in the medication text. */
export function classesForName(text: string): { member: string; classes: string[] } | null {
  const norm = normalizeMedication(text);
  let best: { member: string; classes: string[] } | null = null;
  for (const [id, c] of Object.entries(file.drug_classes)) {
    for (const m of c.members) {
      if (norm === m || wordHit(norm, m)) {
        if (!best || m.length > best.member.length) best = { member: m, classes: [id] };
        else if (m === best.member && !best.classes.includes(id)) best.classes.push(id);
      }
    }
  }
  if (!best) return null;
  // A name can belong to several classes (warfarin: vitamin K antagonist and anticoagulant).
  const classes = Object.entries(file.drug_classes)
    .filter(([, c]) => c.members.includes(best!.member))
    .map(([id]) => id);
  return { member: best.member, classes };
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Brand or misspelled name -> ingredient names, via NIH RxNav. Cached; failures return []. */
export class RxNormClient {
  private readonly cache = new LRUCache<string, string[]>({ max: 2000, ttl: 7 * 24 * 3600 * 1000 });
  constructor(
    private readonly fetchImpl: FetchLike = (u, i) => fetch(u, i),
    private readonly base = 'https://rxnav.nlm.nih.gov/REST',
  ) {}

  async ingredients(name: string, signal?: AbortSignal): Promise<string[]> {
    const key = normalizeMedication(name);
    const hit = this.cache.get(key);
    if (hit) return hit;
    try {
      const timeout = AbortSignal.timeout(3000);
      const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const approx = (await (await this.fetchImpl(`${this.base}/approximateTerm.json?term=${encodeURIComponent(key)}&maxEntries=1`, { signal: sig })).json()) as {
        approximateGroup?: { candidate?: { rxcui?: string }[] };
      };
      const rxcui = approx.approximateGroup?.candidate?.[0]?.rxcui;
      if (!rxcui || !/^\d+$/.test(rxcui)) return this.remember(key, []);
      const rel = (await (await this.fetchImpl(`${this.base}/rxcui/${rxcui}/related.json?tty=IN+MIN`, { signal: sig })).json()) as {
        relatedGroup?: { conceptGroup?: { conceptProperties?: { name?: string }[] }[] };
      };
      const names = (rel.relatedGroup?.conceptGroup ?? []).flatMap((g) => (g.conceptProperties ?? []).map((p) => (p.name ?? '').toLowerCase())).filter(Boolean);
      return this.remember(key, names);
    } catch {
      return [];
    }
  }

  private remember(key: string, v: string[]): string[] {
    this.cache.set(key, v);
    return v;
  }
}

export async function matchMedications(inputs: string[], rx: RxNormClient | null, signal?: AbortSignal): Promise<MedicationMatch[]> {
  return Promise.all(
    inputs.map(async (input): Promise<MedicationMatch> => {
      const direct = classesForName(input);
      if (direct) return { input, status: 'matched', matched_name: direct.member, via: 'name', classes: direct.classes.map((id) => ({ id, name: file.drug_classes[id]!.name })) };
      if (rx) {
        for (const ing of await rx.ingredients(input, signal)) {
          const viaRx = classesForName(ing);
          if (viaRx) return { input, status: 'matched', matched_name: ing, via: 'rxnorm', classes: viaRx.classes.map((id) => ({ id, name: file.drug_classes[id]!.name })) };
        }
      }
      return { input, status: 'not_recognized', matched_name: null, via: null, classes: [] };
    }),
  );
}

/** Daily supplemental beta-carotene: beta-carotene rows plus vitamin A declared as beta-carotene (1 mcg RAE = 2 mcg). */
function betaCaroteneDaily(products: StackProduct[], spd: Map<string, number>): { amount: number; refs: string[] } {
  let amount = 0;
  const refs = new Set<string>();
  for (const p of products) {
    const s = spd.get(p.label.product_ref) ?? 1;
    for (const ing of p.label.ingredients) {
      if (!ing.per_serving) continue;
      if (ing.nutrient_id === 'beta-carotene') amount += ing.per_serving.amount * s;
      else if (ing.nutrient_id === 'vitamin-a' && ing.form_kind === 'beta_carotene') amount += ing.per_serving.amount * 2 * s;
      else continue;
      refs.add(p.label.product_ref);
    }
  }
  return { amount: round(amount, 2), refs: [...refs] };
}

export function evaluateInteractions(
  a: Pick<StackAnalysis, 'nutrient_totals' | 'products'> | null,
  products: StackProduct[],
  meds: MedicationMatch[],
  conditions: string[],
): InteractionFinding[] {
  const totals = new Map((a?.nutrient_totals ?? []).map((t) => [t.nutrient_id, t]));
  const refsFor = (ids: string[]) => [...new Set(ids.flatMap((id) => totals.get(id)?.contributions.map((c) => c.product_ref) ?? []))];
  const out: InteractionFinding[] = [];

  for (const m of meds) {
    const classIds = new Set(m.classes.map((c) => c.id));
    for (const it of file.interactions) {
      if (!classIds.has(it.class)) continue;
      const refs = refsFor(it.nutrients);
      out.push({
        type: 'medication',
        trigger: m.input,
        trigger_name: file.drug_classes[it.class]!.name,
        nutrient_ids: it.nutrients,
        in_stack: refs.length > 0,
        product_refs: refs,
        kind: it.kind,
        summary: it.summary,
        timing: it.timing,
        source: it.source,
      });
    }
  }

  const spd = new Map((a?.products ?? []).map((p) => [p.product_ref, p.servings_per_day_used]));
  for (const c of conditions) {
    const cond = file.conditions[c];
    if (!cond) continue;
    for (const check of cond.checks) {
      const { amount, refs } =
        check.nutrient === 'beta-carotene'
          ? betaCaroteneDaily(products, spd)
          : { amount: totals.get(check.nutrient)?.daily_total.amount ?? 0, refs: refsFor([check.nutrient]) };
      if (amount < check.min_daily.amount) continue;
      out.push({
        type: 'condition',
        trigger: c,
        trigger_name: cond.name,
        nutrient_ids: [check.nutrient],
        in_stack: true,
        product_refs: refs,
        kind: 'condition',
        summary: check.summary,
        timing: null,
        source: check.source,
      });
    }
  }

  // Duplicates arise when one medication is in two classes (warfarin) with the same interaction text.
  const seen = new Set<string>();
  return sortFindings(
    out.filter((f) => {
      const k = `${f.trigger}|${f.summary}`;
      return seen.has(k) ? false : (seen.add(k), true);
    }),
  );
}

const KIND_ORDER: Record<string, number> = { supplement_changes_drug: 0, additive_risk: 1, two_way: 2, condition: 3, drug_raises_nutrient: 4, drug_lowers_nutrient: 5 };

/** Most consequential first: the stack supplies the nutrient, then the supplement acts on the drug. */
export function sortFindings(f: InteractionFinding[]): InteractionFinding[] {
  return [...f].sort((x, y) => Number(y.in_stack) - Number(x.in_stack) || (KIND_ORDER[x.kind] ?? 9) - (KIND_ORDER[y.kind] ?? 9));
}

/** Everything the data file lists for these medications and conditions, without a stack (POST /v1/interactions/check). */
export function listInteractions(meds: MedicationMatch[], conditions: string[], nutrientIds: string[] | null): InteractionFinding[] {
  const wanted = nutrientIds ? new Set(nutrientIds) : null;
  const keep = (ids: string[]) => !wanted || ids.some((id) => wanted.has(id));
  const out: InteractionFinding[] = evaluateInteractions(null, [], meds, []).filter((f) => keep(f.nutrient_ids));
  for (const c of conditions) {
    const cond = file.conditions[c];
    if (!cond) continue;
    for (const check of cond.checks) {
      if (!keep([check.nutrient])) continue;
      out.push({
        type: 'condition',
        trigger: c,
        trigger_name: cond.name,
        nutrient_ids: [check.nutrient],
        in_stack: false,
        product_refs: [],
        kind: 'condition',
        summary: `${check.summary} (Checked from ${check.min_daily.amount} ${check.min_daily.unit} a day in a stack.)`,
        timing: null,
        source: check.source,
      });
    }
  }
  return sortFindings(out);
}

export function conditionName(id: string): string {
  return file.conditions[id]?.name ?? id;
}
