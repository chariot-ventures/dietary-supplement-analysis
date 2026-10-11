import type { Nutrient } from './types.js';
import { round } from './text.js';

export type MassUnit = 'g' | 'mg' | 'mcg';
/** RAE: retinol activity equivalents; DFE: dietary folate equivalents; NE: niacin equivalents; AT: alpha-tocopherol. */
export type Basis = 'RAE' | 'DFE' | 'NE' | 'AT';

export type ParsedUnit =
  | { kind: 'mass'; unit: MassUnit; basis: Basis | null }
  | { kind: 'iu' }
  | { kind: 'unknown'; raw: string };

const MASS_ALIASES: Record<string, MassUnit> = {
  g: 'g',
  gm: 'g',
  gram: 'g',
  grams: 'g',
  mg: 'mg',
  milligram: 'mg',
  milligrams: 'mg',
  mcg: 'mcg',
  ug: 'mcg',
  'µg': 'mcg',
  'μg': 'mcg',
  microgram: 'mcg',
  micrograms: 'mcg',
};

const BASIS_ALIASES: Record<string, Basis> = {
  rae: 'RAE',
  dfe: 'DFE',
  ne: 'NE',
  at: 'AT',
  ate: 'AT',
  'a te': 'AT',
  'alpha te': 'AT',
  'a tocopherol': 'AT',
  'alpha tocopherol': 'AT',
};

const MCG_PER: Record<MassUnit, number> = { g: 1_000_000, mg: 1_000, mcg: 1 };

/** Parse a label unit string such as "mcg", "Milligram(s)", "mcg DFE", "IU" or "mg a-TE". */
export function parseUnit(raw: string): ParsedUnit {
  const s = raw
    .toLowerCase()
    .replace(/\(s\)/g, '')
    .replace(/[-_.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s === 'iu' || s === 'i u' || s === 'international unit' || s === 'international units') return { kind: 'iu' };

  const [head, ...rest] = s.split(' ');
  const unit = head === undefined ? undefined : MASS_ALIASES[head];
  if (!unit) return { kind: 'unknown', raw };
  if (rest.length === 0) return { kind: 'mass', unit, basis: null };
  const basis = BASIS_ALIASES[rest.join(' ')];
  return basis ? { kind: 'mass', unit, basis } : { kind: 'unknown', raw };
}

export function convertMass(amount: number, from: MassUnit, to: MassUnit): number {
  return (amount * MCG_PER[from]) / MCG_PER[to];
}

export type ConversionResult =
  | { ok: true; amount: number; unit: string; converted: boolean; note: string | null }
  | { ok: false; reason: string };

function canonicalMass(n: Nutrient): { unit: MassUnit; basis: Basis | null } {
  const p = parseUnit(n.canonical_unit);
  if (p.kind !== 'mass') throw new Error(`nutrient ${n.id} has non-mass canonical unit ${n.canonical_unit}`);
  return p;
}

function appliesTo(forms: string[], formKind: string | null): boolean {
  return forms.includes('*') || (formKind !== null && forms.includes(formKind));
}

/**
 * Convert a label amount to the nutrient's canonical unit. Only conversions
 * that are unambiguous for the given form are applied; anything else returns
 * ok: false with a reason suitable for a UNIT_NOT_CONVERTIBLE data gap.
 *
 * `formKind` is the single form kind declared on the label (see match.ts),
 * or null when no form, or more than one, was declared.
 */
export function toCanonical(n: Nutrient, amount: number, rawUnit: string, formKind: string | null): ConversionResult {
  const src = parseUnit(rawUnit);
  const canon = canonicalMass(n);
  const done = (value: number, note: string | null): ConversionResult => ({
    ok: true,
    amount: round(value, 4),
    unit: n.canonical_unit,
    converted: note !== null,
    note,
  });

  if (src.kind === 'unknown') {
    return { ok: false, reason: `Label unit "${rawUnit}" cannot be converted to ${n.canonical_unit}` };
  }

  if (src.kind === 'iu') {
    const iuRules = n.unit_conversions.filter((c) => parseUnit(c.from).kind === 'iu');
    const rule = iuRules.find((c) => appliesTo(c.applies_to_forms, formKind));
    if (!rule) {
      return {
        ok: false,
        reason: iuRules.length
          ? `Label gives IU and the IU factor for ${n.name} depends on form; form is ${formKind ? `"${formKind}", which has no IU factor` : 'unspecified or mixed'}. Cannot convert to ${n.canonical_unit}`
          : `Label gives IU, which has no defined conversion to ${n.canonical_unit} for ${n.name}`,
      };
    }
    return done(amount * rule.factor, rule.note ?? `IU x ${rule.factor}`);
  }

  // Plain or basis-qualified mass.
  if (src.basis === canon.basis) {
    const value = convertMass(amount, src.unit, canon.unit);
    return done(value, src.unit === canon.unit ? null : `${src.unit} to ${canon.unit}`);
  }

  if (src.basis !== null && canon.basis === null && n.plain_mass_is_canonical && (src.basis === 'NE' || src.basis === 'AT')) {
    const value = convertMass(amount, src.unit, canon.unit);
    return done(value, src.unit === canon.unit ? null : `${src.unit} to ${canon.unit}`);
  }

  if (src.basis === null && canon.basis !== null) {
    const rule = n.unit_conversions.find((c) => {
      const p = parseUnit(c.from);
      return p.kind === 'mass' && p.basis === null && appliesTo(c.applies_to_forms, formKind);
    });
    if (rule) {
      const from = parseUnit(rule.from) as { kind: 'mass'; unit: MassUnit };
      const value = convertMass(convertMass(amount, src.unit, from.unit) * rule.factor, from.unit, canon.unit);
      return done(value, rule.factor === 1 && src.unit === canon.unit ? null : (rule.note ?? `${rule.from} x ${rule.factor}`));
    }
    return {
      ok: false,
      reason: `Label gives plain ${src.unit} for ${n.name}; converting to ${n.canonical_unit} requires a known form${formKind ? ` (declared form "${formKind}" has no factor)` : ''}`,
    };
  }

  return { ok: false, reason: `Label unit "${rawUnit}" uses a different basis than ${n.canonical_unit}` };
}

/**
 * The part of a canonical amount that counts toward the UL, in `ul_unit`.
 * Returns null when it cannot be determined (form unspecified or mixed).
 */
export function ulPortion(n: Nutrient, canonicalAmount: number, formKind: string | null): number | null {
  if (n.ul_unit === null) return null;
  const canon = canonicalMass(n);
  const ul = parseUnit(n.ul_unit);
  if (ul.kind !== 'mass') return null;
  const inUlUnit = (v: number) => round(convertMass(v, canon.unit, ul.unit), 4);

  switch (n.ul_component) {
    case 'all':
      return inUlUnit(canonicalAmount);
    case 'preformed':
      if (formKind === 'preformed') return inUlUnit(canonicalAmount);
      if (formKind === 'beta_carotene' || formKind === 'other_carotenoid') return 0;
      return null;
    case 'folic_acid': {
      if (formKind === 'other_folate') return 0;
      if (formKind !== 'folic_acid') return null;
      const rule = n.unit_conversions.find((c) => c.applies_to_forms.includes('folic_acid') && parseUnit(c.from).kind === 'mass');
      return rule ? inUlUnit(canonicalAmount / rule.factor) : null;
    }
  }
}

export function formatAmount(amount: number, unit: string): string {
  return `${round(amount, 4)} ${unit}`;
}
