/**
 * Reference intake lookup, ported from SuppleTracker's CompTable DRI logic.
 * Differences from the app: returns every reference type (RDA, EAR, AI, UL),
 * not just the first one found, and uses whole-year age matching.
 */
import type { AgeRange, DriType, LifeStage, Nutrient, Sex, StageTable } from './types.js';

export interface ReferenceValues {
  rda: number | null;
  ear: number | null;
  ai: number | null;
  ul: number | null;
}

/** Whole-year age a range applies to: 30.9 years matches "19-30". */
export function rangeMatches(range: AgeRange, age: number): boolean {
  const years = Math.floor(age);
  if (range.lower !== null && years < range.lower) return false;
  if (range.upper !== null && years > range.upper) return false;
  return true;
}

export function lookupValue(n: Nutrient, type: DriType, age: number, sex: Sex): number | null {
  const table = n.dri?.[type];
  if (!table) return null;
  return table[sex].find((r) => rangeMatches(r, age))?.amount ?? null;
}

function stageValue(table: StageTable | null | undefined, type: DriType, unit: number): number | null {
  return table?.[type]?.find((r) => rangeMatches(r, unit))?.amount ?? null;
}

/**
 * Reference values for a profile. Under 1 year, the infant tables (by month:
 * 0-5, 6-11) apply. Pregnancy and lactation use their own tables (ages 14-50);
 * callers validate that combination first (assertSupportedProfile).
 */
export function lookupReference(n: Nutrient, age: number, sex: Sex, lifeStage?: LifeStage | null): ReferenceValues {
  if (age < 1) {
    const months = Math.floor(age * 12);
    const t = n.life_stages?.infants;
    return { rda: stageValue(t, 'rda', months), ear: stageValue(t, 'ear', months), ai: stageValue(t, 'ai', months), ul: stageValue(t, 'ul', months) };
  }
  if (lifeStage) {
    const t = n.life_stages?.[lifeStage];
    return { rda: stageValue(t, 'rda', age), ear: stageValue(t, 'ear', age), ai: stageValue(t, 'ai', age), ul: stageValue(t, 'ul', age) };
  }
  return {
    rda: lookupValue(n, 'rda', age, sex),
    ear: lookupValue(n, 'ear', age, sex),
    ai: lookupValue(n, 'ai', age, sex),
    ul: lookupValue(n, 'ul', age, sex),
  };
}

/** The target intake a total is compared against: RDA, or AI when no RDA exists. */
export function targetIntake(ref: ReferenceValues): { type: 'rda' | 'ai'; amount: number } | null {
  if (ref.rda !== null) return { type: 'rda', amount: ref.rda };
  if (ref.ai !== null) return { type: 'ai', amount: ref.ai };
  return null;
}
