import { describe, expect, it } from 'vitest';
import { analyzeStack, type StackProduct } from '../src/lib/analyze.js';
import { normalizeCustomProduct, normalizeDsldLabel } from '../src/lib/label.js';
import { makeLabel, normalizedFixture, q } from './helpers.js';

const female34 = { age: 34, sex: 'female' as const };
const custom = (ref: string, ingredients: Parameters<typeof normalizeCustomProduct>[2], servings_per_day?: number): StackProduct => ({
  label: normalizeCustomProduct(ref, ref, ingredients),
  servings_per_day,
});
const total = (r: ReturnType<typeof analyzeStack>, id: string) => r.nutrient_totals.find((t) => t.nutrient_id === id);

describe('analyzeStack', () => {
  it('totals across products and flags above_ul', () => {
    const r = analyzeStack([{ label: normalizedFixture(900001) }, { label: normalizedFixture(900002) }], female34);
    const d = total(r, 'vitamin-d')!;
    expect(d.daily_total).toEqual({ amount: 175, unit: 'mcg' });
    expect(d.flags).toEqual(['above_ul']);
    expect(d.percent_of_ul).toBe(175);
    expect(r.overlaps).toContainEqual({ nutrient_id: 'vitamin-d', product_refs: ['dsld:900001', 'dsld:900002'] });
    expect(r.nutrient_totals[0]!.flags).toContain('above_ul'); // flagged first
  });

  it('defaults servings_per_day to the label maximum and says so', () => {
    const r = analyzeStack([{ label: normalizedFixture(900002) }], female34);
    expect(r.products[0]).toMatchObject({ servings_per_day_used: 2, servings_source: 'label_maximum' });
    expect(r.assumptions[0]).toBe('dsld:900002: servings_per_day not given; used label maximum of 2 (label: 1-2 Tablet(s), 1 time(s) daily)');
  });

  it('uses servings_per_day from the request when given', () => {
    const r = analyzeStack([{ label: normalizedFixture(900002), servings_per_day: 1 }], female34);
    expect(total(r, 'vitamin-d')!.daily_total.amount).toBe(25);
    expect(r.products[0]!.servings_source).toBe('request');
  });

  it('magnesium UL covers supplements only and is labelled with that scope', () => {
    const r = analyzeStack([custom('custom:1', [{ name: 'magnesium', amount: 400, unit: 'mg' }])], female34);
    const mg = total(r, 'magnesium')!;
    expect(mg.flags).toEqual(['above_ul']);
    expect(mg.reference).toMatchObject({ ul: 350, ul_scope: 'supplements_and_medications' });
    expect(mg.reference!.ul_note).toMatch(/supplements and medications only/);
    // Magnesium's UL is not a total-intake UL, so no total-intake caveat is added for it.
    expect(r.assumptions.join(' ')).not.toMatch(/UL for Magnesium/);
  });

  it('adds the total-intake caveat for total-intake ULs', () => {
    const r = analyzeStack([custom('custom:1', [{ name: 'zinc', amount: 10, unit: 'mg' }])], female34);
    expect(r.assumptions.join(' ')).toMatch(/UL for Zinc applies to total intake/);
  });

  it('folate UL compares folic acid only', () => {
    const r = analyzeStack(
      [custom('custom:1', [{ name: 'folate', amount: 1700, unit: 'mcg DFE', form: 'folic acid' }]), custom('custom:2', [{ name: 'folate', amount: 1700, unit: 'mcg DFE', form: 'L-methylfolate' }])],
      female34,
    );
    const f = total(r, 'folate')!;
    expect(f.daily_total).toEqual({ amount: 3400, unit: 'mcg DFE' });
    expect(f.amount_toward_ul).toEqual({ amount: 1000, unit: 'mcg folic acid' });
    expect(f.percent_of_ul).toBe(100);
    expect(f.flags).toEqual([]); // equal to the UL is not above it
  });

  it('vitamin A with mixed forms: UL portion unknown, percent withheld, gap reported', () => {
    const r = analyzeStack([{ label: normalizedFixture(900002), servings_per_day: 1 }], female34);
    const a = total(r, 'vitamin-a')!;
    expect(a.amount_toward_ul).toEqual({ amount: 0, unit: 'mcg' });
    expect(a.percent_of_ul).toBeNull();
    expect(r.data_gaps.find((g) => g.code === 'UL_PARTIAL')).toMatchObject({ nutrient_id: 'vitamin-a' });
  });

  it('a lower-bound total still flags above_ul when the known part exceeds it', () => {
    const r = analyzeStack(
      [
        custom('custom:1', [{ name: 'vitamin a', amount: 3500, unit: 'mcg RAE', form: 'retinyl palmitate' }]),
        custom('custom:2', [{ name: 'vitamin a', amount: 10000, unit: 'IU' }]),
      ],
      female34,
    );
    const a = total(r, 'vitamin-a')!;
    expect(a.complete).toBe(false);
    expect(a.flags).toEqual(['above_ul']);
    expect(a.percent_of_ul).toBe(116.7);
  });

  it('IU vitamin A with unknown form is a UNIT_NOT_CONVERTIBLE gap and not totaled', () => {
    const r = analyzeStack([{ label: normalizedFixture(900004) }], female34);
    expect(r.data_gaps.find((g) => g.code === 'UNIT_NOT_CONVERTIBLE')?.nutrient_id).toBe('vitamin-a');
    expect(total(r, 'vitamin-a')).toBeUndefined();
    expect(total(r, 'vitamin-e')!.daily_total).toEqual({ amount: 268, unit: 'mg' });
  });

  it('flags below_reference only for complete totals and explains it', () => {
    const r = analyzeStack([custom('custom:1', [{ name: 'vitamin c', amount: 20, unit: 'mg' }])], female34);
    expect(total(r, 'vitamin-c')!.flags).toEqual(['below_reference']);
    expect(r.summary.below_reference).toBe(1);
    expect(r.assumptions.join(' ')).toMatch(/below_reference compares supplement totals alone/);
  });

  it('uses AI when there is no RDA', () => {
    const r = analyzeStack([custom('custom:1', [{ name: 'vitamin k', amount: 180, unit: 'mcg' }])], female34);
    expect(total(r, 'vitamin-k')).toMatchObject({ percent_of_rda: null, percent_of_ai: 200, flags: [] });
  });

  it('without age and sex: totals and overlaps, no comparisons, PROFILE_MISSING gap', () => {
    const r = analyzeStack([{ label: normalizedFixture(900001) }, { label: normalizedFixture(900002) }], null);
    const d = total(r, 'vitamin-d')!;
    expect(d).toMatchObject({ reference: null, percent_of_ul: null, flags: [] });
    expect(r.overlaps.length).toBeGreaterThan(0);
    expect(r.data_gaps.map((g) => g.code)).toContain('PROFILE_MISSING');
  });

  it('always reports that interactions are not assessed, and lists unrecognized ingredients', () => {
    const r = analyzeStack([{ label: normalizedFixture(900005) }], female34);
    expect(r.data_gaps.at(-1)?.code).toBe('INTERACTIONS_NOT_ASSESSED');
    expect(r.unrecognized_ingredients[0]).toMatchObject({ product_ref: 'dsld:900005', label_name: 'Ashwagandha root extract' });
  });

  it('non-DRI compounds are totaled for overlap with no reference', () => {
    const l = (id: number) => normalizeDsldLabel(makeLabel(id, [{ name: 'Melatonin', ingredientGroup: 'Melatonin', quantity: q(5, 'mg') }]));
    const r = analyzeStack([{ label: l(1) }, { label: { ...l(2), product_ref: 'dsld:2' } }], female34);
    expect(total(r, 'melatonin')).toMatchObject({ daily_total: { amount: 10, unit: 'mg' }, reference: null, flags: [] });
  });
});
