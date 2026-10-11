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
import { formKindsOf, groupQualifier, matchIngredient, type IngredientInput, type MatchedBy } from './match.js';
import { round } from './text.js';
import type { Nutrient } from './types.js';
import { convertMass, parseUnit, toCanonical, ulPortion, type ConversionResult, type MassUnit } from './units.js';

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
  /** Per serving, the part the UL applies to, in the nutrient's ul_unit (e.g. folic acid only); null when unknown or no UL unit. */
  toward_ul_per_serving: number | null;
  in_blend: boolean;
  blend_name?: string;
  /** Nested label rows that break this nutrient down by form (e.g. folate 800 mcg DFE = folic acid 480 mcg). */
  form_breakdown?: FormBreakdownEntry[];
}

export interface FormBreakdownEntry {
  label_name: string;
  form_kind: string | null;
  label_amount: Amount | null;
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
  | 'DATA_SUSPECT'
  | 'PRODUCT_NOT_RESOLVED'
  | 'INTERACTIONS_NOT_ASSESSED';

/** Why a DATA_SUSPECT gap was raised. */
export type SuspectCheck = 'duplicate_row' | 'nested_exceeds_parent' | 'percent_dv_mismatch' | 'implausible_amount';

export interface DataGap {
  code: DataGapCode;
  product_ref?: string;
  nutrient_id?: string;
  /** For DATA_SUSPECT: which consistency check failed. */
  check?: SuspectCheck;
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
  /** Date the label version was entered into DSLD; newer entries are newer label versions. */
  entry_date: string | null;
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
  // DSLD writes "NP" (or nothing) when no unit was captured. Keep a positive
  // amount as declared; convertWithDvCheck may recover the unit from the %DV.
  if (isMissingUnit(unit)) return q.quantity > 0 ? { amount: q.quantity, unit: unit || 'NP' } : null;
  return { amount: q.quantity, unit };
}

function isMissingUnit(unit: string): boolean {
  return MISSING_UNITS.has(unit.trim().toLowerCase());
}

function pickQuantity(row: DsldIngredientRow, servingOrder: number): DsldQuantity | undefined {
  const qs = row.quantity ?? [];
  return qs.find((q) => (q.servingSizeOrder ?? 1) === servingOrder) ?? qs[0];
}

function percentDv(q: DsldQuantity | undefined): number | null {
  const groups = (q?.dailyValueTargetGroup ?? []).filter((g) => typeof g.percent === 'number');
  const p = (groups.find((g) => /adults and children 4/i.test(g.name ?? '')) ?? groups[0])?.percent;
  return typeof p === 'number' ? p : null;
}

/** %DV for the general adult population only; other groups (children, pregnancy) use different Daily Values. */
function adultPercentDv(q: DsldQuantity | undefined): number | null {
  const g = (q?.dailyValueTargetGroup ?? []).find((x) => typeof x.percent === 'number' && /adults and children 4/i.test(x.name ?? ''));
  return typeof g?.percent === 'number' ? g.percent : null;
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
  breakdown?: FormBreakdownEntry[];
  notes?: string | null;
  /** %DV printed for adults and children 4+, for the label consistency check. */
  adultPercentDv?: number | null;
}

type FormSplit = { status: 'none' } | { status: 'partial'; detail: string } | { status: 'full'; parts: { kind: string; pct: number }[] };

const NOTE_PERCENT = /(\d+(?:\.\d+)?)\s*%\s*(?:as\s+|from\s+)?([a-z][a-z0-9' -]*?)(?=\s*(?:,|\)|;|\band\b|$))/gi;

/**
 * Older labels state form shares: "Vitamin A 5000 IU (40% as beta-carotene)".
 * Shares come from DSLD's forms[].percent or the row notes. When they cover
 * 100% of the amount with known forms, the amount is split exactly; when they
 * cover less, the rest has an unstated form and is treated as mixed.
 */
function formSplit(n: Nutrient, row: RowInput): FormSplit {
  const entries: { kind: string | null; pct: number; name: string }[] = [];
  for (const f of row.forms ?? []) {
    if (typeof f.percent !== 'number' || !(f.percent > 0 && f.percent <= 100)) continue;
    const kinds = formKindsOf(n, [f.name, groupQualifier(f.ingredientGroup)]);
    entries.push({ kind: kinds.size === 1 ? [...kinds][0]! : null, pct: f.percent, name: f.name });
  }
  if (entries.length === 0 && row.notes) {
    for (const m of row.notes.matchAll(NOTE_PERCENT)) {
      const pct = Number(m[1]);
      const kinds = formKindsOf(n, [m[2]!.trim()]);
      if (kinds.size === 1 && pct > 0 && pct <= 100) entries.push({ kind: [...kinds][0]!, pct, name: m[2]!.trim() });
    }
  }
  if (entries.length === 0) return { status: 'none' };
  const total = entries.reduce((sum, e) => sum + e.pct, 0);
  if (entries.every((e) => e.kind !== null) && Math.abs(total - 100) <= 1) {
    const parts = new Map<string, number>();
    for (const e of entries) parts.set(e.kind!, (parts.get(e.kind!) ?? 0) + e.pct);
    return { status: 'full', parts: [...parts].map(([kind, pct]) => ({ kind, pct })) };
  }
  return { status: 'partial', detail: `the label states ${entries.map((e) => `${e.pct}% ${e.name}`).join(', ')}; the form of the remaining ${Math.max(0, 100 - total)}% is not stated` };
}

/**
 * Current labels declare vitamin A in mcg RAE, but DSLD often stores the unit
 * as plain "mcg" or "mg". When the label's %DV matches the Daily Value in the
 * canonical basis, read the amount in that basis.
 */
function convertWithDvCheck(n: Nutrient, amount: Amount, formKind: string | null, pctDv: number | null): ConversionResult {
  const missingUnit = isMissingUnit(amount.unit);
  const conv: ConversionResult = missingUnit
    ? { ok: false, reason: `DSLD lists ${amount.amount} for ${n.name} with no unit${n.label_dv && pctDv !== null ? ' and the %DV does not identify one' : ''}` }
    : toCanonical(n, amount.amount, amount.unit, formKind);
  if (conv.ok || !n.label_dv || pctDv === null || pctDv <= 0) return conv;
  const dv = parseUnit(n.label_dv.unit);
  if (dv.kind !== 'mass') return conv;

  // Units to try: the declared plain mass unit (read in the DV's basis), or every mass unit when none was captured.
  const src = parseUnit(amount.unit);
  const candidates: MassUnit[] = missingUnit ? ['mcg', 'mg', 'g'] : src.kind === 'mass' && src.basis === null ? [src.unit] : [];
  for (const unit of candidates) {
    const inDvUnit = convertMass(amount.amount, unit, dv.unit);
    const expected = (inDvUnit / n.label_dv.amount) * 100;
    if (Math.abs(expected - pctDv) > Math.max(1.5, pctDv * 0.05)) continue;
    const retry = toCanonical(n, inDvUnit, n.label_dv.unit, formKind);
    if (!retry.ok) continue;
    return {
      ...retry,
      converted: true,
      note: missingUnit
        ? `DSLD lists no unit; read as ${amount.amount} ${unit} because the label's ${pctDv}% DV matches the ${n.label_dv.amount} ${n.label_dv.unit} Daily Value`
        : `Label unit "${amount.unit}" read as ${n.label_dv.unit}: the label's ${pctDv}% DV matches the ${n.label_dv.amount} ${n.label_dv.unit} Daily Value`,
    };
  }
  return conv;
}

/** UL portion from a form breakdown, when every entry has a known form and amount. */
function ulFromBreakdown(n: Nutrient, breakdown: FormBreakdownEntry[]): number | null {
  const ul = n.ul_unit ? parseUnit(n.ul_unit) : null;
  if (!ul || ul.kind !== 'mass' || breakdown.length === 0) return null;
  let sum = 0;
  for (const b of breakdown) {
    if (!b.form_kind || !b.label_amount) return null;
    if (ulPortion(n, 1, b.form_kind) === 0) continue; // a form the UL does not apply to
    const src = parseUnit(b.label_amount.unit);
    if (src.kind === 'mass' && src.basis === null) {
      // Plain mass of the form itself: mcg folic acid, mcg retinol (= mcg RAE).
      sum += convertMass(b.label_amount.amount, src.unit, ul.unit);
      continue;
    }
    const c = toCanonical(n, b.label_amount.amount, b.label_amount.unit, b.form_kind);
    const part = c.ok ? ulPortion(n, c.amount, b.form_kind) : null;
    if (part === null) return null;
    sum += part;
  }
  return round(sum, 4);
}

/** Convert a row whose amount is split across forms by stated percentages. */
function convertSplit(n: Nutrient, amount: Amount, parts: { kind: string; pct: number }[]): ConversionResult & { towardUl?: number | null } {
  let total = 0;
  let towardUl: number | null = 0;
  for (const p of parts) {
    const c = toCanonical(n, (amount.amount * p.pct) / 100, amount.unit, p.kind);
    if (!c.ok) return { ok: false, reason: `${c.reason} (for the ${p.pct}% stated as ${p.kind})` };
    total += c.amount;
    const ul = ulPortion(n, c.amount, p.kind);
    towardUl = towardUl === null || ul === null ? null : towardUl + ul;
  }
  return {
    ok: true,
    amount: round(total, 4),
    unit: n.canonical_unit,
    converted: true,
    note: `Split by the label's stated form shares: ${parts.map((p) => `${p.pct}% ${p.kind}`).join(', ')}`,
    towardUl: towardUl === null ? null : round(towardUl, 4),
  };
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
  const breakdown = row.breakdown ?? [];
  const kinds = new Set([...match.form_kinds, ...breakdown.flatMap((b) => (b.form_kind ? [b.form_kind] : []))]);
  const split = row.isCustom ? ({ status: 'none' } as const) : formSplit(n, row);
  let formKind = kinds.size === 1 ? [...kinds][0]! : null;
  if (split.status === 'partial') formKind = null;
  if (split.status === 'full' && split.parts.length === 1) formKind = split.parts[0]!.kind;
  const ing: NormalizedIngredient = {
    label_name: row.name,
    nutrient_id: n.id,
    nutrient_name: n.name,
    matched_by: match.matched_by,
    forms: (row.forms ?? []).map((f) => f.name),
    form_kind: formKind,
    per_serving: null,
    label_amount: row.amount,
    conversion_note: null,
    percent_dv: row.percentDv,
    toward_ul_per_serving: null,
    in_blend: row.inBlend,
  };
  if (row.blendName) ing.blend_name = row.blendName;
  if (breakdown.length) ing.form_breakdown = breakdown;

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
    const multi = split.status === 'full' && split.parts.length > 1 ? convertSplit(n, row.amount, split.parts) : null;
    const conv = multi ?? convertWithDvCheck(n, row.amount, formKind, row.percentDv);
    if (conv.ok) {
      ing.per_serving = { amount: conv.amount, unit: conv.unit };
      ing.conversion_note = conv.note;
      ing.toward_ul_per_serving =
        multi?.ok === true
          ? (multi.towardUl ?? null)
          : ((n.ul_component === 'all' ? null : ulFromBreakdown(n, breakdown)) ?? ulPortion(n, conv.amount, formKind));
      if (!row.isCustom) checkAmount(n, row, ing, ctx);
    } else {
      gap('UNIT_NOT_CONVERTIBLE', split.status === 'partial' ? `${conv.reason} (${split.detail})` : conv.reason);
    }
  }
  out.ingredients.push(ing);
  return { nutrient: n, quantified: row.amount !== null };
}

const pctFmt = (v: number) => `${Math.round(v)}%`;

/**
 * Consistency checks on a converted DSLD row. They catch data-entry errors in
 * DSLD (an amount typed in the wrong unit, a %DV that contradicts the amount).
 * The amount is still counted; the gap tells the caller to check the label.
 */
function checkAmount(n: Nutrient, row: RowInput, ing: NormalizedIngredient, ctx: RowContext): void {
  const per = ing.per_serving;
  if (!per) return;
  const suspect = (check: SuspectCheck, detail: string) =>
    ctx.out.data_gaps.push({ code: 'DATA_SUSPECT', check, product_ref: ctx.productRef, nutrient_id: n.id, detail });

  // Far above any adult UL: typically mg typed for mcg (1000x).
  const ulTable = n.dri?.ul;
  if (ulTable && n.ul_unit && ing.toward_ul_per_serving !== null) {
    const maxUl = Math.max(...[...ulTable.male, ...ulTable.female].map((r) => r.amount));
    if (ing.toward_ul_per_serving > maxUl * 50) {
      suspect(
        'implausible_amount',
        `"${row.name}" lists ${row.amount?.amount} ${row.amount?.unit} per serving, over 50 times the highest adult UL for ${n.name} (${maxUl} ${n.ul_unit}). The unit may have been entered wrongly in DSLD; check the label image before relying on this total.`,
      );
      return;
    }
  }

  // The printed %DV should match the amount under the current or the pre-2016 Daily Value.
  const pdv = row.adultPercentDv ?? null;
  if (pdv === null || pdv < 5 || !n.label_dv || !n.label_dv_legacy || (ing.conversion_note ?? '').includes('DV')) return;
  const canon = parseUnit(per.unit);
  const dvs = [n.label_dv, n.label_dv_legacy].map((dv) => ({ dv, u: parseUnit(dv.unit) }));
  if (canon.kind !== 'mass') return;
  const expected: number[] = [];
  for (const { dv, u } of dvs) {
    if (u.kind !== 'mass' || u.basis !== canon.basis) return;
    expected.push((convertMass(per.amount, canon.unit, u.unit) / dv.amount) * 100);
  }
  const close = expected.some((e) => Math.abs(e - pdv) <= Math.max(5, pdv * 0.25));
  if (!close) {
    suspect(
      'percent_dv_mismatch',
      `"${row.name}" lists ${row.amount?.amount} ${row.amount?.unit} with ${pdv}% DV, but that amount is ${expected.map(pctFmt).join(' (current DV) or ')} (pre-2016 DV). The amount or the %DV may have been entered wrongly in DSLD.`,
    );
  }
}

/** Same nutrient listed twice under one parent with the same name: usually a DSLD entry error (e.g. EPA entered as DHA). */
function checkDuplicates(out: NormalizedLabel): void {
  const groups = new Map<string, NormalizedIngredient[]>();
  for (const ing of out.ingredients) {
    if (!ing.label_amount) continue;
    const key = `${ing.blend_name ?? ''}\u0000${ing.nutrient_id}\u0000${ing.label_name.trim().toLowerCase()}`;
    groups.set(key, [...(groups.get(key) ?? []), ing]);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const first = list[0]!;
    out.data_gaps.push({
      code: 'DATA_SUSPECT',
      check: 'duplicate_row',
      product_ref: out.product_ref,
      nutrient_id: first.nutrient_id,
      detail: `"${first.label_name}" appears ${list.length} times${first.blend_name ? ` in "${first.blend_name}"` : ''} with amounts ${list.map((i) => `${i.label_amount!.amount} ${i.label_amount!.unit}`).join(' and ')}. One row may be a different ingredient entered under the wrong name in DSLD; all are counted.`,
    });
  }
}

/** Nested rows whose amounts add up to more than their parent's declared total. */
function checkNestedSum(parent: DsldIngredientRow, parentAmount: Amount | null, servingOrder: number, ctx: RowContext): void {
  const pu = parentAmount ? parseUnit(parentAmount.unit) : null;
  if (!parentAmount || !pu || pu.kind !== 'mass' || pu.basis !== null || parentAmount.amount <= 0) return;
  let sum = 0;
  for (const row of parent.nestedRows ?? []) {
    const a = labelAmount(pickQuantity(row, servingOrder));
    if (!a) continue;
    const u = parseUnit(a.unit);
    if (u.kind !== 'mass' || u.basis !== null) return; // mixed bases: not comparable
    sum += convertMass(a.amount, u.unit, pu.unit);
  }
  if (sum > parentAmount.amount * 1.05 + 1e-9) {
    ctx.out.data_gaps.push({
      code: 'DATA_SUSPECT',
      check: 'nested_exceeds_parent',
      product_ref: ctx.productRef,
      detail: `The rows listed under "${parent.name}" add up to ${round(sum, 3)} ${pu.unit}, more than its declared ${parentAmount.amount} ${parentAmount.unit}. An amount or unit may have been entered wrongly in DSLD.`,
    });
  }
}

function rowInput(row: DsldIngredientRow, servingOrder: number): RowInput {
  const q = pickQuantity(row, servingOrder);
  return {
    name: row.name,
    ingredientGroup: row.ingredientGroup,
    uniiCode: row.uniiCode,
    alternateNames: row.alternateNames ?? [],
    forms: (row.forms ?? []).filter((f) => f?.name),
    category: row.category,
    amount: labelAmount(q),
    percentDv: percentDv(q),
    adultPercentDv: adultPercentDv(q),
    inBlend: false,
    isCustom: false,
    notes: row.notes ?? null,
  };
}

/**
 * Rows nested under a quantified nutrient row describe that nutrient's forms
 * (Thorne: Vitamin A 1050 mcg = Beta-Carotene 450 mcg + Vitamin A Palmitate
 * 600 mcg). They are never counted again; they feed form detection and the UL
 * portion. Nested ingredients unrelated to the parent are handled normally.
 */
function collectBreakdown(rows: DsldIngredientRow[], parent: Nutrient, servingOrder: number, ctx: RowContext, sink: FormBreakdownEntry[]): void {
  for (const row of rows) {
    if (!row?.name) continue;
    const input = rowInput(row, servingOrder);
    const m = matchIngredient(input);
    const names = [row.name, ...(row.alternateNames ?? []), ...(input.forms ?? []).map((f) => f.name), groupQualifier(row.ingredientGroup)];
    const kinds = m?.nutrient.id === parent.id ? new Set(m.form_kinds) : formKindsOf(parent, names);
    if (m?.nutrient.id === parent.id || (!m && kinds.size > 0)) {
      sink.push({ label_name: row.name, form_kind: kinds.size === 1 ? [...kinds][0]! : null, label_amount: input.amount });
    } else if (!m && row.nestedRows?.length) {
      collectBreakdown(row.nestedRows, parent, servingOrder, ctx, sink); // a blend of the parent's forms
    } else {
      walkDsldRows([row], servingOrder, ctx);
    }
  }
}

function walkDsldRows(rows: DsldIngredientRow[], servingOrder: number, ctx: RowContext, blend?: { name: string; unquantified: string[] }): void {
  for (const row of rows) {
    if (!row?.name) continue;
    const input = rowInput(row, servingOrder);
    const { amount } = input;
    const nested = row.nestedRows ?? [];
    const inBlend = blend !== undefined;
    input.inBlend = inBlend;
    if (blend) input.blendName = blend.name;

    const match = nested.length ? matchIngredient(input) : null;
    // A row with nested rows that is not itself a nutrient is a blend container.
    if (nested.length && !match) {
      ctx.out.unrecognized_ingredients.push({ label_name: row.name, category: row.category ?? null, per_serving: amount, in_blend: inBlend, is_blend: true });
      checkNestedSum(row, amount, servingOrder, ctx);
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

    if (match && amount && nested.length) {
      const breakdown: FormBreakdownEntry[] = [];
      collectBreakdown(nested, match.nutrient, servingOrder, ctx, breakdown);
      input.breakdown = breakdown;
      addRow(input, ctx);
      continue;
    }

    const { quantified } = addRow(input, ctx);
    if (blend && !quantified) blend.unquantified.push(row.name);
    // A nutrient row without its own amount: count whatever its nested rows declare.
    if (nested.length) walkDsldRows(nested, servingOrder, ctx, blend);
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

function emptyLabel(partial: Pick<NormalizedLabel, 'dsld_id' | 'product_ref' | 'brand' | 'name' | 'upc' | 'on_market' | 'entry_date' | 'serving' | 'source_url'>): NormalizedLabel {
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
    entry_date: typeof label.entryDate === 'string' && label.entryDate ? label.entryDate : null,
    serving: info,
    source_url: dsldLabelUrl(label.id),
  });
  const rows = label.ingredientRows ?? [];
  walkDsldRows(rows, order, { productRef: out.product_ref, out });
  checkDuplicates(out);
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
    entry_date: null,
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
