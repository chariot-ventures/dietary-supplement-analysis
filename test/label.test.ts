import { describe, expect, it } from 'vitest';
import { normalizeCustomProduct, normalizeDsldLabel } from '../src/lib/label.js';
import { makeLabel, normalizedFixture, q } from './helpers.js';

describe('normalizeDsldLabel', () => {
  it('keeps the label amount next to the converted amount', () => {
    const l = normalizedFixture(900001);
    expect(l.ingredients[0]).toMatchObject({
      label_name: 'Vitamin D3',
      nutrient_id: 'vitamin-d',
      forms: ['Cholecalciferol'],
      per_serving: { amount: 125, unit: 'mcg' },
      label_amount: { amount: 5000, unit: 'IU' },
      percent_dv: 625,
      in_blend: false,
    });
    expect(l).toMatchObject({ dsld_id: 900001, on_market: true, source_url: 'https://dsld.od.nih.gov/label/900001' });
    expect(l.statements[0]?.type).toBe('Precautions');
  });

  it('computes daily servings from serving size and servingSizeQuantity', () => {
    // 1-2 tablets once daily, amounts per 1 tablet -> up to 2 servings/day
    expect(normalizedFixture(900002).serving).toMatchObject({ quantity: 1, unit: 'Tablet(s)', daily_servings: { min: 1, max: 2 } });
    // 2 capsules once daily, amounts per 2 capsules -> 1 serving/day
    expect(normalizedFixture(900003).serving).toMatchObject({ quantity: 2, daily_servings: { min: 1, max: 1 } });
  });

  it('picks the quantity for the primary serving size, not quantity[0]', () => {
    const label = makeLabel(1, [
      {
        name: 'Zinc',
        ingredientGroup: 'Zinc',
        quantity: [
          { servingSizeOrder: 2, servingSizeQuantity: 2, quantity: 30, unit: 'mg' },
          { servingSizeOrder: 1, servingSizeQuantity: 1, quantity: 15, unit: 'mg' },
        ],
      },
    ]);
    expect(normalizeDsldLabel(label).ingredients[0]?.per_serving).toEqual({ amount: 15, unit: 'mg' });
  });

  it('reports unquantified blend members once per blend, without distributing the blend weight', () => {
    const l = normalizedFixture(900005);
    const blendGaps = l.data_gaps.filter((g) => g.code === 'BLEND_UNQUANTIFIED');
    expect(blendGaps).toHaveLength(1);
    expect(blendGaps[0]!.detail).toContain('3 ingredient(s)');
    expect(l.unrecognized_ingredients.find((u) => u.label_name === 'Proprietary Calm Blend')).toMatchObject({ is_blend: true });
    expect(l.ingredients.some((i) => i.in_blend)).toBe(false);
  });

  it('counts quantified nutrients inside a blend', () => {
    const label = makeLabel(2, [
      { name: 'Sleep Blend', quantity: q(500, 'mg'), nestedRows: [{ name: 'Melatonin', ingredientGroup: 'Melatonin', quantity: q(3, 'mg') }, { name: 'Valerian root', quantity: [] }] },
    ]);
    const l = normalizeDsldLabel(label);
    expect(l.ingredients).toEqual([expect.objectContaining({ nutrient_id: 'melatonin', in_blend: true, blend_name: 'Sleep Blend', per_serving: { amount: 3, unit: 'mg' } })]);
    expect(l.data_gaps.map((g) => g.code)).toEqual(['BLEND_UNQUANTIFIED']);
  });

  it('does not double count a nested row restating the parent nutrient', () => {
    const label = makeLabel(3, [
      { name: 'Vitamin A', ingredientGroup: 'Vitamin A', quantity: q(900, 'mcg RAE'), nestedRows: [{ name: 'Vitamin A', ingredientGroup: 'Vitamin A', quantity: q(450, 'mcg RAE') }] },
    ]);
    expect(normalizeDsldLabel(label).ingredients).toHaveLength(1);
  });

  it('records QUANTITY_MISSING, UNIT_NOT_CONVERTIBLE and COMPOUND_WEIGHT gaps', () => {
    const label = makeLabel(4, [
      { name: 'Biotin', ingredientGroup: 'Biotin', quantity: q(null, 'mcg') },
      { name: 'Vitamin A', ingredientGroup: 'Vitamin A', quantity: q(10000, 'IU') },
      { name: 'Calcium Carbonate', ingredientGroup: 'Calcium', quantity: q(1250, 'mg') },
      { name: 'Vitamin C', ingredientGroup: 'Vitamin C', quantity: q(0, 'NP') },
    ]);
    const l = normalizeDsldLabel(label);
    expect(l.data_gaps.map((g) => [g.code, g.nutrient_id])).toEqual([
      ['QUANTITY_MISSING', 'biotin'],
      ['UNIT_NOT_CONVERTIBLE', 'vitamin-a'],
      ['COMPOUND_WEIGHT', 'calcium'],
      ['QUANTITY_MISSING', 'vitamin-c'],
    ]);
    expect(l.ingredients.every((i) => i.per_serving === null)).toBe(true);
  });

  it('a missing unit is a gap unless the %DV identifies it', () => {
    const noDv = normalizeDsldLabel(makeLabel(5, [{ name: 'Zinc', ingredientGroup: 'Zinc', quantity: q(15, 'NP') }]));
    expect(noDv.data_gaps).toEqual([expect.objectContaining({ code: 'UNIT_NOT_CONVERTIBLE', nutrient_id: 'zinc' })]);
    const wrongDv = normalizeDsldLabel(
      makeLabel(6, [{ name: 'Zinc', ingredientGroup: 'Zinc', quantity: [{ servingSizeOrder: 1, quantity: 15, unit: 'NP', dailyValueTargetGroup: [{ name: 'Adults and children 4 or more years of age', percent: 100 }] }] }]),
    );
    expect(wrongDv.ingredients[0]?.per_serving).toBeNull(); // 15 mg would be 136%, not 100% (old 15 mg DV): not guessed
  });

  it('splits IU vitamin A exactly when the stated form shares cover 100%', () => {
    const row = (notes: string) => [{ name: 'Vitamin A', ingredientGroup: 'Vitamin A', notes, forms: [{ name: 'Retinyl Palmitate' }, { name: 'Beta Carotene' }], quantity: q(5000, 'IU') }];
    const full = normalizeDsldLabel(makeLabel(7, row('Vitamin A (Form: 60% as Retinyl Palmitate, 40% as Beta Carotene)'))).ingredients[0]!;
    // 3000 IU x 0.3 + 2000 IU x 0.15 = 900 + 300 mcg RAE; only the retinyl palmitate counts toward the UL
    expect(full).toMatchObject({ per_serving: { amount: 1200, unit: 'mcg RAE' }, toward_ul_per_serving: 900 });
    const dsldPercent = normalizeDsldLabel(
      makeLabel(8, [{ name: 'Vitamin A', ingredientGroup: 'Vitamin A', forms: [{ name: 'Retinyl Palmitate', percent: 60 }, { name: 'Beta Carotene', percent: 40 }], quantity: q(5000, 'IU') }]),
    ).ingredients[0]!;
    expect(dsldPercent.per_serving).toEqual({ amount: 1200, unit: 'mcg RAE' });
  });

  it('lists unrecognized ingredients with their label amount', () => {
    expect(normalizedFixture(900005).unrecognized_ingredients[0]).toMatchObject({ label_name: 'Ashwagandha root extract', per_serving: { amount: 300, unit: 'mg' } });
  });

  it('reports off-market labels', () => {
    expect(normalizedFixture(900004).on_market).toBe(false);
  });
});

describe('normalizeCustomProduct', () => {
  it('requires nutrient_basis for compound names', () => {
    const l = normalizeCustomProduct('custom:1', 'Mg', [{ name: 'magnesium citrate', amount: 500, unit: 'mg' }]);
    expect(l.data_gaps[0]?.code).toBe('AMBIGUOUS_BASIS');
    expect(l.ingredients[0]?.per_serving).toBeNull();
  });

  it('counts elemental amounts and refuses compound weight', () => {
    const elemental = normalizeCustomProduct('custom:1', 'Mg', [{ name: 'magnesium glycinate', amount: 200, unit: 'mg', nutrient_basis: 'elemental' }]);
    expect(elemental.ingredients[0]?.per_serving).toEqual({ amount: 200, unit: 'mg' });
    const compound = normalizeCustomProduct('custom:1', 'Mg', [{ name: 'magnesium', amount: 1000, unit: 'mg', nutrient_basis: 'compound' }]);
    expect(compound.data_gaps[0]?.code).toBe('COMPOUND_WEIGHT');
  });

  it('uses the declared form for conversions', () => {
    const l = normalizeCustomProduct('custom:1', 'E', [{ name: 'vitamin e', amount: 400, unit: 'IU', form: 'd-alpha tocopherol' }]);
    expect(l.ingredients[0]?.per_serving).toEqual({ amount: 268, unit: 'mg' });
  });
});
