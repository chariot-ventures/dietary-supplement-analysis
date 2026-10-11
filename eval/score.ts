/**
 * Scoring shared by the service eval (eval/run.ts) and the LLM comparison
 * (eval/llm-compare.ts). A case passes when every expectation it states holds.
 */
import data from './cases.json' with { type: 'json' };

export interface Expect {
  above: string[];
  near: string[];
  amounts?: Record<string, number>;
  severity?: Record<string, string>;
  interactions?: string[];
  no_in_stack?: boolean;
  botanicals?: string[];
  dose?: string[];
  gaps?: string[];
  /** Nutrients above the UL once the listed foods are added (with_foods, or food-only totals). */
  food_above?: string[];
}
export interface EvalCase {
  id: string;
  category: string;
  question: string;
  request: Record<string, unknown>;
  expect: Expect;
  why: string;
}
export const CASES = (data as unknown as { cases: EvalCase[] }).cases;

/** What an answer claimed, in the service's IDs. */
export interface Claims {
  above: string[];
  near: string[];
  amounts?: Record<string, number>;
  severity?: Record<string, string>;
  /** "trigger|nutrient-or-botanical", for interactions involving something in the stack. */
  interactions: string[];
  botanicals?: string[];
  dose?: string[];
  gaps?: string[];
  food_above?: string[];
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Problems found; an empty list means the case passed. */
export function score(e: Expect, c: Claims): string[] {
  const p: string[] = [];
  if (!sameSet([...new Set(c.above)].sort(), [...e.above].sort())) p.push(`above_ul: expected [${e.above}] got [${c.above}]`);
  if (!sameSet([...new Set(c.near)].sort(), [...e.near].sort())) p.push(`near_ul: expected [${e.near}] got [${c.near}]`);
  for (const [id, amt] of Object.entries(e.amounts ?? {})) {
    const got = c.amounts?.[id];
    if (got === undefined || Math.abs(got - amt) > Math.max(0.005 * amt, 0.01)) p.push(`${id} amount: expected ${amt} got ${got}`);
  }
  for (const [id, sev] of Object.entries(e.severity ?? {})) if (c.severity?.[id] !== sev) p.push(`${id} severity: expected ${sev} got ${c.severity?.[id]}`);
  const lower = (xs: string[]) => xs.map((x) => x.toLowerCase());
  for (const i of lower(e.interactions ?? [])) if (!lower(c.interactions).includes(i)) p.push(`missing interaction ${i}`);
  if (e.no_in_stack && c.interactions.length) p.push(`unexpected interactions [${c.interactions}]`);
  if (e.botanicals && !sameSet([...new Set(c.botanicals ?? [])].sort(), [...e.botanicals].sort())) p.push(`botanicals: expected [${e.botanicals}] got [${c.botanicals}]`);
  for (const d of e.dose ?? []) if (!(c.dose ?? []).includes(d)) p.push(`missing dose finding for ${d}`);
  for (const g of e.gaps ?? []) if (!(c.gaps ?? []).includes(g)) p.push(`missing gap ${g}`);
  if (e.food_above && !sameSet([...new Set(c.food_above ?? [])].sort(), [...e.food_above].sort())) p.push(`above_ul with foods: expected [${e.food_above}] got [${c.food_above}]`);
  return p;
}

/** Claims from a full stack_analyze response. */
export function claimsFromService(body: Record<string, unknown>): Claims {
  const totals = (body.nutrient_totals ?? []) as { nutrient_id: string; flags: string[]; severity: string | null; amount_toward_ul: { amount: number } | null; daily_total: { amount: number } }[];
  const ix = (body.interactions as { findings: { trigger: string; in_stack: boolean; nutrient_ids: string[]; botanical_ids: string[] }[] } | undefined)?.findings ?? [];
  const bots = (body.botanicals ?? []) as { id: string; dose_findings: unknown[] }[];
  return {
    above: totals.filter((t) => t.flags.includes('above_ul')).map((t) => t.nutrient_id),
    near: totals.filter((t) => t.flags.includes('near_ul')).map((t) => t.nutrient_id),
    amounts: Object.fromEntries(totals.map((t) => [t.nutrient_id, (t.amount_toward_ul ?? t.daily_total).amount])),
    severity: Object.fromEntries(totals.filter((t) => t.severity).map((t) => [t.nutrient_id, t.severity!])),
    interactions: ix.filter((f) => f.in_stack).flatMap((f) => [...f.nutrient_ids, ...f.botanical_ids].map((id) => `${f.trigger}|${id}`)),
    botanicals: bots.map((b) => b.id),
    dose: bots.filter((b) => b.dose_findings.length).map((b) => b.id),
    gaps: ((body.data_gaps ?? []) as { code: string }[]).map((g) => g.code),
    food_above: [
      ...(body.nutrient_totals as { nutrient_id: string; with_foods?: { flags: string[] } }[] ?? []).filter((t) => t.with_foods?.flags.includes('above_ul')).map((t) => t.nutrient_id),
      ...(((body.foods as { totals?: { nutrient_id: string; flags?: string[] }[] } | undefined)?.totals ?? []).filter((t) => t.flags?.includes('above_ul')).map((t) => t.nutrient_id)),
    ],
  };
}
