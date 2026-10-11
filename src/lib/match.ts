/**
 * Ingredient -> nutrient matching (PLAN.md section 6), in order:
 *   1. DSLD ingredientGroup
 *   2. UNII code (row or form)
 *   3. exact normalized name / alternate name / synonym
 *   4. exact form name belonging to exactly one nutrient ("magnesium glycinate")
 * No substring or fuzzy matching, so "Vitamin B" never matches "Vitamin B12".
 */
import { nutrientIndex, type NutrientIndex } from './nutrients.js';
import { normalizeName } from './text.js';
import type { Nutrient } from './types.js';

export interface IngredientInput {
  name: string;
  ingredientGroup?: string | null;
  uniiCode?: string | null;
  alternateNames?: string[];
  forms?: { name: string; uniiCode?: string | null; ingredientGroup?: string | null; percent?: number | null }[];
}

export type MatchedBy = 'ingredient_group' | 'unii' | 'name' | 'form';

export interface IngredientMatch {
  nutrient: Nutrient;
  matched_by: MatchedBy;
  /** The single form kind declared, or null when none or several were declared. */
  form_kind: string | null;
  /** Every form kind declared. */
  form_kinds: string[];
  mixed_forms: boolean;
  /** The row's own name is a compound (e.g. "Magnesium Citrate"), so its amount may be compound weight. */
  name_is_compound: boolean;
}

export function matchIngredient(input: IngredientInput, index: NutrientIndex = nutrientIndex): IngredientMatch | null {
  const names = [input.name, ...(input.alternateNames ?? [])].filter((s) => s && s.trim());
  let nutrient: Nutrient | undefined;
  let matchedBy: MatchedBy | undefined;

  if (input.ingredientGroup) {
    nutrient = index.byIngredientGroup(input.ingredientGroup);
    if (nutrient) matchedBy = 'ingredient_group';
    // A more specific entry may claim rows by exact name inside a broad DSLD group,
    // e.g. "D-Gamma-Tocopherol" is filed under "Vitamin E" but is not alpha-tocopherol.
    const byName = names.map((s) => index.bySynonymName(s)).find((n) => n !== undefined);
    if (byName && byName.id !== nutrient?.id && byName.name_overrides_groups.some((g) => normalizeName(g) === normalizeName(input.ingredientGroup!))) {
      nutrient = byName;
      matchedBy = 'name';
    }
  }
  if (!nutrient) {
    for (const code of [input.uniiCode, ...(input.forms ?? []).map((f) => f.uniiCode)]) {
      if (!code) continue;
      nutrient = index.byUniiCode(code);
      if (nutrient) {
        matchedBy = 'unii';
        break;
      }
    }
  }
  if (!nutrient) {
    for (const name of names) {
      nutrient = index.bySynonymName(name);
      if (nutrient) {
        matchedBy = 'name';
        break;
      }
    }
  }
  if (!nutrient) {
    const hits = index.formHits(input.name);
    const owners = new Set(hits.map((h) => h.nutrient.id));
    if (owners.size === 1) {
      nutrient = hits[0]!.nutrient;
      matchedBy = 'form';
    }
  }
  if (!nutrient || !matchedBy) return null;

  const kinds = formKindsOf(nutrient, [
    input.name,
    ...(input.alternateNames ?? []),
    ...(input.forms ?? []).map((f) => f.name),
    // DSLD group names often carry the form: "Vitamin B9 (methylfolate)", "Vitamin A (retinyl palmitate)".
    ...[input.ingredientGroup, ...(input.forms ?? []).map((f) => f.ingredientGroup)].map(groupQualifier),
  ]);
  const nameKey = normalizeName(input.name);
  const nameIsCompound = nutrient.forms.some((f) => f.kind === 'compound' && normalizeName(f.name) === nameKey);

  return {
    nutrient,
    matched_by: matchedBy,
    form_kind: kinds.size === 1 ? [...kinds][0]! : null,
    form_kinds: [...kinds],
    mixed_forms: kinds.size > 1,
    name_is_compound: nameIsCompound,
  };
}

/** Form kinds of `nutrient` named by any of `names` (compound salts and food sources excluded). */
export function formKindsOf(nutrient: Nutrient, names: string[]): Set<string> {
  const keys = new Set(names.map(normalizeName));
  const kinds = new Set<string>();
  for (const f of nutrient.forms) {
    if (f.kind === 'compound' || f.kind === 'food_source') continue;
    if (keys.has(normalizeName(f.name))) kinds.add(f.kind);
  }
  return kinds;
}

/** "Vitamin B9 (methylfolate)" -> "methylfolate"; "" when there is no qualifier. */
export function groupQualifier(group: string | null | undefined): string {
  return /\(([^()]+)\)\s*$/.exec(group ?? '')?.[1] ?? '';
}
