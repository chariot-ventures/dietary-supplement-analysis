/**
 * Optional "typical diet" estimate: adds the US mean intake from food and
 * beverages for the person's age and sex (WWEIA, NHANES 2017-March 2020) to
 * the supplement totals, so the UL and RDA comparisons reflect total intake
 * rather than supplements alone. An individual's diet can differ widely; the
 * estimate is labelled as such everywhere it appears.
 */
import data from '../../data/typical-intake.json' with { type: 'json' };
import type { DietEstimate, Flag, NutrientTotal, Profile, StackAnalysis } from './analyze.js';
import { NEAR_UL_PERCENT } from './analyze.js';
import { nutrientIndex } from './nutrients.js';
import { round } from './text.js';

interface Row {
  unit: string;
  male: number[];
  female: number[];
}
interface DietFile {
  source: { name: string; url: string; retrieved: string };
  age_groups: [number, number | null][];
  rows: Record<string, Row>;
  nutrients: Record<string, { total: string; toward_ul: string | null }>;
}
const file = data as unknown as DietFile;

export const DIET_SOURCE = file.source;

function groupIndex(age: number): number {
  return file.age_groups.findIndex(([lo, hi]) => age >= lo && (hi === null || Math.floor(age) <= hi));
}

/** Food amount (and the part that counts toward the UL) for one nutrient, or null when there is no data for this profile. */
export function foodIntake(nutrientId: string, profile: Profile): { total: number; towardUl: number | null; unit: string } | null {
  if (profile.age < 2 || profile.life_stage) return null;
  const map = file.nutrients[nutrientId];
  const i = groupIndex(profile.age);
  if (!map || i < 0) return null;
  const total = file.rows[map.total]?.[profile.sex][i];
  if (total === undefined) return null;
  const n = nutrientIndex.get(nutrientId);
  let towardUl: number | null;
  if (map.toward_ul === null) towardUl = n?.ul_scope === 'supplements_and_medications' ? 0 : null;
  else towardUl = file.rows[map.toward_ul]?.[profile.sex][i] ?? null;
  return { total, towardUl, unit: file.rows[map.total]!.unit };
}

const pct = (v: number, of: number | null | undefined) => (of == null || of <= 0 ? null : round((v / of) * 100, 1));

export type FoodGetter = (nutrientId: string) => { total: number; towardUl: number | null; unit: string } | null;

/**
 * Adds a food estimate (field) to each nutrient total that has food data.
 * Leaves supplement-only fields untouched. Returns how many totals got one.
 */
export function applyFoodEstimate(a: StackAnalysis, field: 'with_typical_diet' | 'with_foods', food: FoodGetter): number {
  let applied = 0;
  for (const t of a.nutrient_totals) {
    const f = food(t.nutrient_id);
    if (!f || !t.reference) continue;
    t[field] = estimate(t, f);
    applied++;
  }
  return applied;
}

function estimate(t: NutrientTotal, food: { total: number; towardUl: number | null; unit: string }): DietEstimate {
  const total = round(t.daily_total.amount + food.total, 2);
  const ul = t.reference!.ul;
  const toward = t.amount_toward_ul && food.towardUl !== null ? round(t.amount_toward_ul.amount + food.towardUl, 2) : null;
  const percentUl = toward !== null ? pct(toward, ul) : null;
  const flags: Flag[] = [];
  if (percentUl !== null && percentUl > 100) flags.push('above_ul');
  else if (percentUl !== null && percentUl >= NEAR_UL_PERCENT) flags.push('near_ul');
  const target = t.reference!.rda !== null ? { reference: 'rda' as const, amount: t.reference!.rda } : t.reference!.ai !== null ? { reference: 'ai' as const, amount: t.reference!.ai } : null;
  return {
    food: { amount: food.total, unit: food.unit },
    estimated_total: { amount: total, unit: t.daily_total.unit },
    amount_toward_ul: toward !== null ? { amount: toward, unit: t.amount_toward_ul!.unit } : null,
    percent_of_ul: percentUl,
    coverage: target ? { reference: target.reference, percent: pct(total, target.amount)! } : null,
    flags,
  };
}

/**
 * Adds with_typical_diet to each nutrient total that has food data, and returns
 * the assumption text to add. Leaves supplement-only fields untouched.
 */
export function applyTypicalDiet(a: StackAnalysis): { applied: number; note: string | null } {
  if (!a.profile) return { applied: 0, note: null };
  if (a.profile.age < 2 || a.profile.life_stage) {
    return { applied: 0, note: 'diet "typical" was not applied: US food intake data covers ages 2 and up, without pregnancy or lactation.' };
  }
  const profile = a.profile;
  const applied = applyFoodEstimate(a, 'with_typical_diet', (id) => foodIntake(id, profile));
  return {
    applied,
    note: `with_typical_diet adds the US average intake from food and drinks for a ${a.profile.sex} of this age (What We Eat in America, NHANES 2017-March 2020) to the supplement totals. A person's own diet can be much higher or lower.`,
  };
}

/** Nutrients that are flagged only once typical food intake is added. */
export function dietOnlyFlags(a: StackAnalysis, field: 'with_typical_diet' | 'with_foods' = 'with_typical_diet'): { t: NutrientTotal; est: DietEstimate }[] {
  return a.nutrient_totals
    .map((t) => ({ t, est: t[field] }))
    .filter((x): x is { t: NutrientTotal; est: DietEstimate } => !!x.est && x.est.flags.length > 0 && x.t.flags.length === 0);
}
