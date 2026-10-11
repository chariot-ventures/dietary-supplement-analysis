import { describe, expect, it } from 'vitest';
import { nutrientIndex } from '../src/lib/nutrients.js';
import { convertMass, parseUnit, toCanonical, ulPortion } from '../src/lib/units.js';

const n = (id: string) => nutrientIndex.get(id)!;
const amountOf = (r: ReturnType<typeof toCanonical>) => (r.ok ? r.amount : `gap: ${r.reason}`);

describe('parseUnit', () => {
  it.each([
    ['mg', { kind: 'mass', unit: 'mg', basis: null }],
    ['Milligram(s)', { kind: 'mass', unit: 'mg', basis: null }],
    ['µg', { kind: 'mass', unit: 'mcg', basis: null }],
    ['Gram(s)', { kind: 'mass', unit: 'g', basis: null }],
    ['mcg DFE', { kind: 'mass', unit: 'mcg', basis: 'DFE' }],
    ['mcg RAE', { kind: 'mass', unit: 'mcg', basis: 'RAE' }],
    ['mg NE', { kind: 'mass', unit: 'mg', basis: 'NE' }],
    ['mg a-TE', { kind: 'mass', unit: 'mg', basis: 'AT' }],
    ['IU', { kind: 'iu' }],
    ['International Unit(s)', { kind: 'iu' }],
  ])('%s', (raw, expected) => expect(parseUnit(raw)).toEqual(expected));

  it('rejects unknown units', () => {
    expect(parseUnit('CFU').kind).toBe('unknown');
    expect(parseUnit('%').kind).toBe('unknown');
    expect(parseUnit('mg XYZ').kind).toBe('unknown');
  });
});

describe('metric conversion', () => {
  it('g, mg and mcg', () => {
    expect(convertMass(1, 'g', 'mg')).toBe(1000);
    expect(convertMass(2500, 'mcg', 'mg')).toBe(2.5);
    expect(amountOf(toCanonical(n('magnesium'), 0.4, 'g', null))).toBe(400);
    expect(amountOf(toCanonical(n('copper'), 2, 'mg', null))).toBe(2000);
  });
});

describe('vitamin D', () => {
  it('1 mcg = 40 IU for any form', () => {
    expect(amountOf(toCanonical(n('vitamin-d'), 5000, 'IU', 'd3'))).toBe(125);
    expect(amountOf(toCanonical(n('vitamin-d'), 1000, 'IU', null))).toBe(25);
    expect(amountOf(toCanonical(n('vitamin-d'), 50, 'mcg', null))).toBe(50);
  });
});

describe('vitamin E', () => {
  it('natural IU x 0.67, synthetic IU x 0.45', () => {
    expect(amountOf(toCanonical(n('vitamin-e'), 400, 'IU', 'natural'))).toBe(268);
    expect(amountOf(toCanonical(n('vitamin-e'), 100, 'IU', 'synthetic'))).toBe(45);
  });
  it('unknown form in IU is a gap', () => {
    const r = toCanonical(n('vitamin-e'), 400, 'IU', null);
    expect(r.ok).toBe(false);
  });
  it('mg and mg alpha-tocopherol need no conversion', () => {
    expect(amountOf(toCanonical(n('vitamin-e'), 15, 'mg', null))).toBe(15);
    expect(amountOf(toCanonical(n('vitamin-e'), 15, 'mg a-TE', null))).toBe(15);
  });
});

describe('vitamin A', () => {
  it('mcg RAE needs no conversion, whatever the form', () => {
    const r = toCanonical(n('vitamin-a'), 900, 'mcg RAE', null);
    expect(r).toMatchObject({ ok: true, amount: 900, converted: false });
  });
  it('IU converts only when the form is unambiguous', () => {
    expect(amountOf(toCanonical(n('vitamin-a'), 10000, 'IU', 'preformed'))).toBe(3000);
    expect(amountOf(toCanonical(n('vitamin-a'), 10000, 'IU', 'beta_carotene'))).toBe(1500);
    expect(toCanonical(n('vitamin-a'), 10000, 'IU', null).ok).toBe(false);
    expect(toCanonical(n('vitamin-a'), 10000, 'IU', 'other_carotenoid').ok).toBe(false);
  });
  it('plain mcg counts as RAE only for preformed vitamin A', () => {
    expect(amountOf(toCanonical(n('vitamin-a'), 900, 'mcg', 'preformed'))).toBe(900);
    expect(toCanonical(n('vitamin-a'), 900, 'mcg', 'beta_carotene').ok).toBe(false);
    expect(toCanonical(n('vitamin-a'), 900, 'mcg', null).ok).toBe(false);
  });
  it('a different basis is never converted', () => {
    expect(toCanonical(n('vitamin-a'), 900, 'mcg DFE', 'preformed').ok).toBe(false);
  });
});

describe('folate', () => {
  it('mcg DFE passes through', () => {
    expect(amountOf(toCanonical(n('folate'), 680, 'mcg DFE', 'folic_acid'))).toBe(680);
  });
  it('plain mcg of folic acid = 1.7 mcg DFE', () => {
    expect(amountOf(toCanonical(n('folate'), 400, 'mcg', 'folic_acid'))).toBe(680);
    expect(amountOf(toCanonical(n('folate'), 1, 'mg', 'folic_acid'))).toBe(1700);
  });
  it('plain mcg of other or unknown forms is a gap', () => {
    expect(toCanonical(n('folate'), 400, 'mcg', 'other_folate').ok).toBe(false);
    expect(toCanonical(n('folate'), 400, 'mcg', null).ok).toBe(false);
  });
});

describe('niacin', () => {
  it('mg and mg NE are both counted as mg niacin', () => {
    expect(amountOf(toCanonical(n('niacin'), 20, 'mg NE', null))).toBe(20);
    expect(amountOf(toCanonical(n('niacin'), 20, 'mg', 'nicotinamide'))).toBe(20);
  });
});

describe('IU for nutrients without an IU factor', () => {
  it('is a gap', () => {
    const r = toCanonical(n('zinc'), 10, 'IU', null);
    expect(r.ok).toBe(false);
  });
});

describe('ulPortion', () => {
  it('folate: folic acid only, DFE / 1.7', () => {
    expect(ulPortion(n('folate'), 680, 'folic_acid')).toBe(400);
    expect(ulPortion(n('folate'), 680, 'other_folate')).toBe(0);
    expect(ulPortion(n('folate'), 680, null)).toBeNull();
  });
  it('vitamin A: preformed only', () => {
    expect(ulPortion(n('vitamin-a'), 900, 'preformed')).toBe(900);
    expect(ulPortion(n('vitamin-a'), 900, 'beta_carotene')).toBe(0);
    expect(ulPortion(n('vitamin-a'), 900, null)).toBeNull();
  });
  it('whole amount for other nutrients', () => {
    expect(ulPortion(n('magnesium'), 350, null)).toBe(350);
    expect(ulPortion(n('vitamin-e'), 268, 'natural')).toBe(268);
  });
  it('null when no UL unit', () => {
    expect(ulPortion(n('melatonin'), 3, null)).toBeNull();
  });
});
