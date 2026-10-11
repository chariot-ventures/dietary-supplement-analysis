/**
 * Stack analysis: per-nutrient daily totals across products, compared with
 * NIH reference intakes. Pure function over already-normalized labels so it
 * is deterministic and testable offline.
 *
 * Wording rule: no flag means "nothing to report", never "safe". This module
 * never emits words like "safe", "no risk" or "no interactions".
 */
import { lookupReference, targetIntake, type ReferenceValues } from './dri.js';
import { dsldSource, factsheetSource, type Source } from './envelope.js';
import type { Amount, DataGap, NormalizedLabel } from './label.js';
import { nutrientIndex } from './nutrients.js';
import { round } from './text.js';
import type { LifeStage, Nutrient, Sex } from './types.js';
import { formatAmount } from './units.js';

export interface Profile {
  age: number;
  sex: Sex;
  /** Pregnancy or lactation reference values (female, 14-50). */
  life_stage?: LifeStage | null;
}

export interface StackProduct {
  label: NormalizedLabel;
  /** As requested by the caller; undefined means "use the default". */
  servings_per_day?: number | undefined;
  retrieved?: string | undefined;
}

export interface Contribution {
  product_ref: string;
  label_name: string;
  label_amount: string | null;
  converted?: Amount;
  servings_per_day: number;
  daily: Amount;
  /** Daily amount counted toward the UL, in the UL unit; null when the form is unknown. */
  daily_toward_ul: number | null;
}

/** above_ul: the amount the UL applies to exceeds it. near_ul: at NEAR_UL_PERCENT-100% of the UL. */
export type Flag = 'above_ul' | 'near_ul';
export type Severity = 'high' | 'moderate' | 'low';

/** Percent of the UL from which a total is flagged near_ul. */
export const NEAR_UL_PERCENT = 90;
/** Percent of the UL from which an above_ul total has high severity. */
export const HIGH_SEVERITY_PERCENT = 200;

export interface NutrientTotal {
  nutrient_id: string;
  name: string;
  daily_total: Amount;
  /** False when some label rows for this nutrient could not be counted (see data_gaps); the total is then a lower bound. */
  complete: boolean;
  reference: {
    rda: number | null;
    ear: number | null;
    ai: number | null;
    ul: number | null;
    unit: string;
    ul_unit: string | null;
    ul_scope: string;
    ul_note: string | null;
    /** What the UL protects against (the Food and Nutrition Board's critical adverse effect). */
    ul_basis: string | null;
  } | null;
  /** Amount compared with the UL (e.g. folic acid only, preformed vitamin A only), in ul_unit. */
  amount_toward_ul: Amount | null;
  percent_of_ul: number | null;
  percent_of_rda: number | null;
  percent_of_ai: number | null;
  /** How much of the RDA (or AI) these supplements alone supply. Informational: diet supplies the rest. */
  coverage: { reference: 'rda' | 'ai'; percent: number } | null;
  flags: Flag[];
  /** high: at least twice the UL; moderate: above the UL; low: within 10% of the UL. Null when nothing is flagged. */
  severity: Severity | null;
  factsheet_url: string;
  contributions: Contribution[];
  /** Present with "diet": "typical": the same comparisons with US average food intake added. */
  with_typical_diet?: DietEstimate;
  /** With "foods": the listed foods (USDA SR28) added to the supplement totals. */
  with_foods?: DietEstimate;
}

export interface DietEstimate {
  /** Mean daily amount from food and beverages for this age and sex. */
  food: Amount;
  /** Supplements plus food. */
  estimated_total: Amount;
  /** The part of the estimated total the UL applies to; null when the food share of it isn't reported. */
  amount_toward_ul: Amount | null;
  percent_of_ul: number | null;
  coverage: { reference: 'rda' | 'ai'; percent: number } | null;
  flags: Flag[];
}

export interface ProductSummary {
  product_ref: string;
  dsld_id: number | null;
  brand: string | null;
  name: string;
  servings_per_day_used: number;
  servings_source: 'request' | 'label_maximum' | 'default';
  entry_date: string | null;
  source_url: string | null;
}

export interface StackAnalysis {
  profile: Profile | null;
  summary: { products_matched: number; nutrients_totaled: number; above_ul: number; near_ul: number; data_gaps: number; data_suspect: number };
  assumptions: string[];
  nutrient_totals: NutrientTotal[];
  overlaps: { nutrient_id: string; product_refs: string[] }[];
  unrecognized_ingredients: { product_ref: string; label_name: string; per_serving: Amount | null; in_blend: boolean }[];
  data_gaps: DataGap[];
  products: ProductSummary[];
  sources: Source[];
}

interface Bucket {
  nutrient: Nutrient;
  total: number;
  towardUl: number;
  ulUnknown: string[];
  contributions: Contribution[];
}

function pct(value: number, of: number | null): number | null {
  return of === null || of <= 0 ? null : round((value / of) * 100, 1);
}

function listNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function analyzeStack(products: StackProduct[], profile: Profile | null): StackAnalysis {
  const assumptions: string[] = [];
  const gaps: DataGap[] = [];
  const buckets = new Map<string, Bucket>();
  const productSummaries: ProductSummary[] = [];
  const unrecognized: StackAnalysis['unrecognized_ingredients'] = [];
  const sources: Source[] = [];

  for (const p of products) {
    const { label } = p;
    let spd: number;
    let servingsSource: ProductSummary['servings_source'];
    if (p.servings_per_day !== undefined) {
      spd = p.servings_per_day;
      servingsSource = 'request';
    } else if (label.serving.daily_servings.max !== null) {
      spd = label.serving.daily_servings.max;
      servingsSource = 'label_maximum';
      assumptions.push(
        `${label.product_ref}: servings_per_day not given; used label maximum of ${spd}${label.serving.label_text ? ` (label: ${label.serving.label_text})` : ''}`,
      );
    } else {
      spd = 1;
      servingsSource = 'default';
      assumptions.push(
        label.dsld_id === null
          ? `${label.product_ref}: servings_per_day not given; amounts treated as one serving per day`
          : `${label.product_ref}: servings_per_day not given and the label states no daily servings; used 1`,
      );
    }

    productSummaries.push({
      product_ref: label.product_ref,
      dsld_id: label.dsld_id,
      brand: label.brand,
      name: label.name,
      servings_per_day_used: spd,
      servings_source: servingsSource,
      entry_date: label.entry_date,
      source_url: label.source_url,
    });
    if (label.source_url) sources.push(dsldSource(label.source_url, p.retrieved ?? ''));
    gaps.push(...label.data_gaps);
    for (const u of label.unrecognized_ingredients) {
      unrecognized.push({ product_ref: label.product_ref, label_name: u.label_name, per_serving: u.per_serving, in_blend: u.in_blend });
    }

    for (const ing of label.ingredients) {
      const n = nutrientIndex.get(ing.nutrient_id);
      if (!n) continue;
      let b = buckets.get(n.id);
      if (!b) {
        b = { nutrient: n, total: 0, towardUl: 0, ulUnknown: [], contributions: [] };
        buckets.set(n.id, b);
      }
      if (!ing.per_serving) continue; // gap already recorded by label normalization

      const daily = round(ing.per_serving.amount * spd, 4);
      const dailyUl = ing.toward_ul_per_serving === null ? null : round(ing.toward_ul_per_serving * spd, 4);
      b.total += daily;
      if (dailyUl === null) b.ulUnknown.push(label.product_ref);
      else b.towardUl += dailyUl;

      b.contributions.push({
        product_ref: label.product_ref,
        label_name: ing.label_name,
        label_amount: ing.label_amount ? formatAmount(ing.label_amount.amount, ing.label_amount.unit) : null,
        ...(ing.conversion_note ? { converted: { amount: ing.per_serving.amount, unit: ing.per_serving.unit } } : {}),
        servings_per_day: spd,
        daily: { amount: daily, unit: n.canonical_unit },
        daily_toward_ul: dailyUl,
      });
    }
  }

  // Nutrients with label rows that could not be counted (missing amount, unconvertible unit, compound weight).
  const incomplete = new Set(gaps.filter((g) => g.nutrient_id).map((g) => g.nutrient_id));
  const totals: NutrientTotal[] = [];
  const totalIntakeUl: string[] = [];
  let anyCoverage = false;

  for (const b of buckets.values()) {
    if (b.contributions.length === 0) continue;
    const n = b.nutrient;
    const complete = !incomplete.has(n.id);
    const ref: ReferenceValues | null = profile && n.dri ? lookupReference(n, profile.age, profile.sex, profile.life_stage) : null;
    const total = round(b.total, 4);
    const towardUl = round(b.towardUl, 4);
    const flags: Flag[] = [];

    let percentUl: number | null = null;
    if (ref?.ul != null) {
      // A lower-bound total can still show the UL is exceeded, but not that it is not.
      const ulComplete = complete && b.ulUnknown.length === 0;
      if (towardUl > ref.ul) flags.push('above_ul');
      percentUl = ulComplete || towardUl > ref.ul ? pct(towardUl, ref.ul) : null;
      if (b.ulUnknown.length) {
        gaps.push({
          code: 'UL_PARTIAL',
          nutrient_id: n.id,
          detail: `${n.name} UL applies to ${n.ul_component === 'folic_acid' ? 'folic acid' : n.ul_component === 'preformed' ? 'preformed vitamin A' : 'part of the total'} only; the form in ${listNames([...new Set(b.ulUnknown)])} is unspecified or mixed, so the amount toward the UL (${towardUl} ${n.ul_unit}) is a lower bound and percent_of_ul is not reported unless the UL is already exceeded`,
        });
      }
      if (n.ul_scope === 'total_intake') totalIntakeUl.push(n.name);
    }

    if (percentUl !== null && !flags.includes('above_ul') && percentUl >= NEAR_UL_PERCENT) flags.push('near_ul');
    const severity: Severity | null = flags.includes('above_ul')
      ? percentUl !== null && percentUl >= HIGH_SEVERITY_PERCENT
        ? 'high'
        : 'moderate'
      : flags.includes('near_ul')
        ? 'low'
        : null;

    const target = ref ? targetIntake(ref) : null;
    const coverage = target ? { reference: target.type, percent: pct(total, target.amount)! } : null;
    if (coverage) anyCoverage = true;

    totals.push({
      nutrient_id: n.id,
      name: n.name,
      daily_total: { amount: total, unit: n.canonical_unit },
      complete,
      reference: ref
        ? { ...ref, unit: n.canonical_unit, ul_unit: n.ul_unit, ul_scope: n.ul_scope, ul_note: n.ul_note, ul_basis: ref.ul !== null ? n.ul_basis : null }
        : null,
      amount_toward_ul: n.ul_unit && n.dri?.ul ? { amount: towardUl, unit: n.ul_component === 'folic_acid' ? `${n.ul_unit} folic acid` : n.ul_unit } : null,
      percent_of_ul: percentUl,
      percent_of_rda: ref ? pct(total, ref.rda) : null,
      percent_of_ai: ref && ref.rda === null ? pct(total, ref.ai) : null,
      coverage,
      flags,
      severity,
      factsheet_url: n.factsheet_url,
      contributions: b.contributions,
    });
    if (ref) sources.push(factsheetSource(n.name, n.factsheet_url, nutrientIndex.driReviewed));
  }

  // Most severe first, then by how far over (or near) the UL, then by name.
  const rank = (t: NutrientTotal) => (t.severity === 'high' ? 3 : t.severity === 'moderate' ? 2 : t.severity === 'low' ? 1 : 0);
  totals.sort((a, b) => rank(b) - rank(a) || (b.percent_of_ul ?? 0) * Number(rank(b) > 0) - (a.percent_of_ul ?? 0) * Number(rank(a) > 0) || a.name.localeCompare(b.name));

  const overlaps = totals
    .map((t) => ({ nutrient_id: t.nutrient_id, product_refs: [...new Set(t.contributions.map((c) => c.product_ref))] }))
    .filter((o) => o.product_refs.length > 1);

  assumptions.push('Totals cover the listed supplements only; food, beverages and medications are not included.');
  if (totalIntakeUl.length) {
    assumptions.push(
      `The UL for ${listNames(totalIntakeUl.sort())} applies to total intake from food and supplements; a supplement total under the UL does not show that total intake is under it.`,
    );
  }
  if (anyCoverage) {
    assumptions.push('coverage compares supplement totals alone with the RDA (or AI); diet normally supplies much of the reference amount, so low coverage does not indicate a shortfall.');
  }
  if (!profile) {
    gaps.push({ code: 'PROFILE_MISSING', detail: 'age and sex were not given, so totals are not compared with reference intakes or upper limits' });
  }
  gaps.push({
    code: 'INTERACTIONS_NOT_ASSESSED',
    detail: 'No medications were given, so medication interactions were not checked (pass medications[]). Supplement-to-supplement interactions are not evaluated.',
  });

  return {
    profile,
    summary: {
      products_matched: products.length,
      nutrients_totaled: totals.length,
      above_ul: totals.filter((t) => t.flags.includes('above_ul')).length,
      near_ul: totals.filter((t) => t.flags.includes('near_ul')).length,
      data_gaps: gaps.length,
      data_suspect: gaps.filter((g) => g.code === 'DATA_SUSPECT').length,
    },
    assumptions,
    nutrient_totals: totals,
    overlaps,
    unrecognized_ingredients: unrecognized,
    data_gaps: gaps,
    products: productSummaries,
    sources,
  };
}
