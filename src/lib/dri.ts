/**
 * Reference intake lookup, ported from SuppleTracker's CompTable DRI logic.
 * Differences from the app: returns every reference type (RDA, EAR, AI, UL),
 * not just the first one found, and uses whole-year age matching.
 */
import type { AgeRange, DriType, Nutrient, Sex } from './types.js';

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

export function lookupReference(n: Nutrient, age: number, sex: Sex): ReferenceValues {
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
