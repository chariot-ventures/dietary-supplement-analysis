/**
 * DSLD label (or caller-supplied custom product) -> normalized label.
 *
 * Ported from SuppleTracker's addGlobalDSLDSupplement, which read only
 * quantity[0] of each top-level row. This version picks the quantity for the
 * label's primary serving size, walks nestedRows (blends), keeps the label
 * amount next to any converted amount, and reports data gaps instead of
 * guessing.
 */
import type { DsldIngredientRow, DsldLabel, DsldQuantity } from './dsld.js';
import { dsldLabelUrl } from './dsld.js';
import { matchIngredient, type IngredientInput, type MatchedBy } from './match.js';
import { round } from './text.js';
import type { Nutrient } from './types.js';
import { toCanonical } from './units.js';

export interface Amount {
  amount: number;
  unit: string;
}

export interface NormalizedIngredient {
  label_name: string;
  nutrient_id: string;
  nutrient_name: string;
  matched_by: MatchedBy;
  forms: string[];
  /** Form kind used for conversions and the UL portion (e.g. "folic_acid", "preformed"); null when unknown or mixed. */
  form_kind: string | null;
  /** Per serving, in the nutrient's canonical unit; null when the amount is missing or not convertible. */
  per_serving: Amount | null;
  /** Exactly as declared on the label. */
  label_amount: Amount | null;
  conversion_note: string | null;
  percent_dv: number | null;
  in_blend: boolean;
  blend_name?: string;
}

export interface UnrecognizedIngredient {
  label_name: string;
  category: string | null;
  per_serving: Amount | null;
  in_blend: boolean;
  is_blend: boolean;
}

export type DataGapCode =
  | 'BLEND_UNQUANTIFIED'
  | 'QUANTITY_MISSING'
  | 'UNIT_NOT_CONVERTIBLE'
  | 'COMPOUND_WEIGHT'
  | 'AMBIGUOUS_BASIS'
  | 'UL_PARTIAL'
  | 'UL_NOT_ASSESSED'
  | 'NO_REFERENCE'
  | 'PROFILE_MISSING'
  | 'SERVINGS_UNKNOWN'
  | 'INTERACTIONS_NOT_ASSESSED';

export interface DataGap {
  code: DataGapCode;
  product_ref?: string;
  nutrient_id?: string;
  detail: string;
}

export interface ServingInfo {
  /** Number of `unit`s the per-serving amounts refer to. */
  quantity: number | null;
  unit: string | null;
  /** Servings per day per the label, in servings of `quantity` `unit`. */
  daily_servings: { min: number | null; max: number | null };
  label_text: string | null;
}

export interface NormalizedLabel {
  dsld_id: number | null;
  product_ref: string;
  brand: string | null;
  name: string;
  upc: string | null;
  on_market: boolean | null;
  serving: ServingInfo;
  ingredient_count: number;
  ingredients: NormalizedIngredient[];
  unrecognized_ingredients: UnrecognizedIngredient[];
  data_gaps: DataGap[];
  statements: { type: string; text: string }[];
  source_url: string | null;
}

const MISSING_UNITS = new Set(['', 'np', 'n/a', 'na']);

function labelAmount(q: DsldQuantity | undefined): Amount | null {
  if (!q || typeof q.quantity !== 'number' || !Number.isFinite(q.quantity)) return null;
  const unit = (q.unit ?? '').trim();
  if (MISSING_UNITS.has(unit.toLowerCase())) return null;
  return { amount: q.quantity, unit };
}

function pickQuantity(row: DsldIngredientRow, servingOrder: number): DsldQuantity | undefined {
  const qs = row.quantity ?? [];
  return qs.find((q) => (q.servingSizeOrder ?? 1) === servingOrder) ?? qs[0];
}

function percentDv(q: DsldQuantity | undefined): number | null {
  const p = q?.dailyValueTargetGroup?.find((g) => typeof g.percent === 'number')?.percent;
  return typeof p === 'number' ? p : null;
}

interface RowContext {
  productRef: string;
  out: NormalizedLabel;
  /** For custom products: what the caller said the amount measures. */
  nutrientBasis?: 'elemental' | 'compound';
}

interface RowInput extends IngredientInput {
  category?: string | null;
  amount: Amount | null;
  percentDv: number | null;
  inBlend: boolean;
  blendName?: string;
  isCustom: boolean;
}

/** Shared by DSLD rows and custom ingredients: match, convert, and record gaps. */
function addRow(row: RowInput, ctx: RowContext): { nutrient: Nutrient | null; quantified: boolean } {
  const { out, productRef } = ctx;
  const match = matchIngredient(row);
  if (!match) {
    out.unrecognized_ingredients.push({
      label_name: row.name,
      category: row.category ?? null,
      per_serving: row.amount,
      in_blend: row.inBlend,
      is_blend: false,
    });
    return { nutrient: null, quantified: row.amount !== null };
  }

  const n = match.nutrient;
  const ing: NormalizedIngredient = {
    label_name: row.name,
    nutrient_id: n.id,
    nutrient_name: n.name,
    matched_by: match.matched_by,
    forms: (row.forms ?? []).map((f) => f.name),
    form_kind: match.form_kind,
    per_serving: null,
    label_amount: row.amount,
    conversion_note: null,
    percent_dv: row.percentDv,
    in_blend: row.inBlend,
  };
  if (row.blendName) ing.blend_name = row.blendName;

  const gap = (code: DataGapCode, detail: string) => out.data_gaps.push({ code, product_ref: productRef, nutrient_id: n.id, detail });

  if (row.amount === null) {
    if (!row.inBlend) gap('QUANTITY_MISSING', `"${row.name}" has no declared amount`);
  } else if (ctx.nutrientBasis === 'compound') {
    gap('COMPOUND_WEIGHT', `"${row.name}" amount is compound weight; the elemental ${n.name} amount is unknown`);
  } else if (match.name_is_compound && ctx.nutrientBasis !== 'elemental') {
    gap(
      row.isCustom ? 'AMBIGUOUS_BASIS' : 'COMPOUND_WEIGHT',
      row.isCustom
        ? `"${row.name}" is a compound; set nutrient_basis to "elemental" if ${row.amount.amount} ${row.amount.unit} is elemental ${n.name}`
        : `Label row "${row.name}" names a compound; its amount may be compound weight, not elemental ${n.name}`,
    );
  } else {
    const conv = toCanonical(n, row.amount.amount, row.amount.unit, match.form_kind);
    if (conv.ok) {
      ing.per_serving = { amount: conv.amount, unit: conv.unit };
      ing.conversion_note = conv.note;
    } else {
      gap('UNIT_NOT_CONVERTIBLE', conv.reason);
    }
  }
  out.ingredients.push(ing);
  return { nutrient: n, quantified: row.amount !== null };
}

function walkDsldRows(rows: DsldIngredientRow[], servingOrder: number, ctx: RowContext, blend?: { name: string; unquantified: string[] }, parentNutrientId?: string): void {
  for (const row of rows) {
    if (!row?.name) continue;
    const q = pickQuantity(row, servingOrder);
    const amount = labelAmount(q);
    const nested = row.nestedRows ?? [];
    const inBlend = blend !== undefined;
    const input: RowInput = {
      name: row.name,
      ingredientGroup: row.ingredientGroup,
      uniiCode: row.uniiCode,
      alternateNames: row.alternateNames ?? [],
      forms: (row.forms ?? []).filter((f) => f?.name),
      category: row.category,
      amount,
      percentDv: percentDv(q),
      inBlend,
      isCustom: false,
    };
    if (blend) input.blendName = blend.name;

    // A row with nested rows that is not itself a nutrient is a blend container.
    const match = nested.length ? matchIngredient(input) : null;
    if (nested.length && !match) {
      ctx.out.unrecognized_ingredients.push({ label_name: row.name, category: row.category ?? null, per_serving: amount, in_blend: inBlend, is_blend: true });
      const inner = { name: row.name, unquantified: [] as string[] };
      walkDsldRows(nested, servingOrder, ctx, inner);
      if (inner.unquantified.length) {
        ctx.out.data_gaps.push({
          code: 'BLEND_UNQUANTIFIED',
          product_ref: ctx.productRef,
          detail: `${/blend/i.test(row.name) ? '' : 'Blend '}"${row.name}"${amount ? ` (${amount.amount} ${amount.unit} total)` : ''} lists ${inner.unquantified.length} ingredient(s) without individual amounts: ${inner.unquantified.slice(0, 8).join(', ')}${inner.unquantified.length > 8 ? ', ...' : ''}`,
        });
      }
      continue;
    }

    // Nested row restating the parent nutrient (a form breakdown): do not count twice.
    if (parentNutrientId && (match ?? matchIngredient(input))?.nutrient.id === parentNutrientId) continue;

    const { nutrient, quantified } = addRow(input, ctx);
    if (blend && !quantified) blend.unquantified.push(row.name);
    if (nested.length && nutrient) walkDsldRows(nested, servingOrder, ctx, blend, quantified ? nutrient.id : undefined);
  }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

function servingInfo(label: DsldLabel): { info: ServingInfo; order: number } {
  const s = label.servingSizes?.[0];
  const order = s?.order ?? 1;
  const firstQ = (label.ingredientRows ?? []).map((r) => pickQuantity(r, order)).find((q) => num(q?.servingSizeQuantity) !== null);
  const basis = num(firstQ?.servingSizeQuantity) ?? num(s?.minQuantity) ?? 1;
  const unit = s?.unit ?? firstQ?.servingSizeUnit ?? null;
  const minQ = num(s?.minQuantity) ?? basis;
  const maxQ = num(s?.maxQuantity) ?? minQ;
  const minD = num(s?.minDailyServings);
  const maxD = num(s?.maxDailyServings) ?? minD;
  const perDay = (q: number, d: number | null) => (d === null ? null : round((q / basis) * d, 3));

  let text: string | null = null;
  if (s) {
    const qty = minQ === maxQ ? `${minQ}` : `${minQ}-${maxQ}`;
    const times = minD === null ? '' : minD === maxD ? `, ${minD} time(s) daily` : `, ${minD}-${maxD} time(s) daily`;
    text = `${qty} ${unit ?? 'serving(s)'}${times}`;
  }
  return {
    order,
    info: { quantity: basis, unit, daily_servings: { min: perDay(minQ, minD), max: perDay(maxQ, maxD) }, label_text: text },
  };
}

function emptyLabel(partial: Pick<NormalizedLabel, 'dsld_id' | 'product_ref' | 'brand' | 'name' | 'upc' | 'on_market' | 'serving' | 'source_url'>): NormalizedLabel {
  return { ...partial, ingredient_count: 0, ingredients: [], unrecognized_ingredients: [], data_gaps: [], statements: [] };
}

export function normalizeDsldLabel(label: DsldLabel): NormalizedLabel {
  const { info, order } = servingInfo(label);
  const out = emptyLabel({
    dsld_id: label.id,
    product_ref: `dsld:${label.id}`,
    brand: label.brandName ?? null,
    name: label.fullName ?? `DSLD label ${label.id}`,
    upc: label.upcSku ?? null,
    on_market: typeof label.offMarket === 'number' ? label.offMarket === 0 : null,
    serving: info,
    source_url: dsldLabelUrl(label.id),
  });
  const rows = label.ingredientRows ?? [];
  walkDsldRows(rows, order, { productRef: out.product_ref, out });
  out.ingredient_count = rows.length;
  out.statements = (label.statements ?? [])
    .filter((s) => s?.notes)
    .map((s) => ({ type: s.type ?? 'Statement', text: String(s.notes).slice(0, 2000) }));
  return out;
}

export interface CustomIngredientInput {
  name: string;
  amount: number;
  unit: string;
  form?: string | undefined;
  nutrient_basis?: 'elemental' | 'compound' | undefined;
}

export function normalizeCustomProduct(productRef: string, name: string, ingredients: CustomIngredientInput[]): NormalizedLabel {
  const out = emptyLabel({
    dsld_id: null,
    product_ref: productRef,
    brand: null,
    name,
    upc: null,
    on_market: null,
    serving: { quantity: 1, unit: 'serving', daily_servings: { min: null, max: null }, label_text: null },
    source_url: null,
  });
  for (const ing of ingredients) {
    const ctx: RowContext = { productRef, out };
    if (ing.nutrient_basis) ctx.nutrientBasis = ing.nutrient_basis;
    addRow(
      {
        name: ing.name,
        forms: ing.form ? [{ name: ing.form }] : [],
        amount: { amount: ing.amount, unit: ing.unit },
        percentDv: null,
        inBlend: false,
        isCustom: true,
      },
      ctx,
    );
  }
  out.ingredient_count = ingredients.length;
  return out;
}
