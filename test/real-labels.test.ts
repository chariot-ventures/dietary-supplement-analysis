import { afterAll, describe, expect, it } from 'vitest';
import { normalizedFixture, testApp } from './helpers.js';

/**
 * Real labels recorded from the NIH DSLD API on 2026-10-11
 * (test/fixtures/dsld/real, via scripts/record-fixtures.ts).
 */
const ing = (id: number, nutrient: string) => normalizedFixture(id).ingredients.find((i) => i.nutrient_id === nutrient)!;

describe('real DSLD labels', () => {
  it('230932 vitamin D3 5000 IU is declared as 125 mcg', () => {
    const l = normalizedFixture(230932);
    expect(l).toMatchObject({ brand: 'Natural Healthy Concepts', on_market: true, data_gaps: [], unrecognized_ingredients: [] });
    expect(ing(230932, 'vitamin-d')).toMatchObject({ per_serving: { amount: 125, unit: 'mcg' }, percent_dv: 625, form_kind: 'd3' });
  });

  it('338022 plain-mcg vitamin A is read as mcg RAE because the %DV matches', () => {
    const a = ing(338022, 'vitamin-a');
    expect(a.per_serving).toEqual({ amount: 1050, unit: 'mcg RAE' });
    expect(a.conversion_note).toMatch(/117% DV matches the 900 mcg RAE/);
    expect(a.form_kind).toBe('beta_carotene');
    expect(a.toward_ul_per_serving).toBe(0);
  });

  it('338022 folate: the nested folic acid row gives the UL portion directly', () => {
    expect(ing(338022, 'folate')).toMatchObject({ per_serving: { amount: 800, unit: 'mcg DFE' }, form_kind: 'folic_acid', toward_ul_per_serving: 480 });
    expect(normalizedFixture(338022).data_gaps).toEqual([]);
  });

  it('323076 vitamin A breakdown: only the palmitate counts toward the UL', () => {
    const a = ing(323076, 'vitamin-a');
    expect(a.per_serving).toEqual({ amount: 1050, unit: 'mcg RAE' });
    expect(a.form_breakdown?.map((b) => b.form_kind)).toEqual(['beta_carotene', 'preformed']);
    expect(a.toward_ul_per_serving).toBe(600);
  });

  it('323076 methylfolate does not count toward the folic acid UL', () => {
    expect(ing(323076, 'folate')).toMatchObject({ form_kind: 'other_folate', toward_ul_per_serving: 0 });
    expect(ing(284181, 'folate')).toMatchObject({ per_serving: { amount: 1700, unit: 'mcg DFE' }, toward_ul_per_serving: 0 });
  });

  it('323076 gamma-tocopherol is not counted as vitamin E', () => {
    const l = normalizedFixture(323076);
    expect(l.ingredients.filter((i) => i.nutrient_id === 'vitamin-e').map((i) => i.per_serving?.amount)).toEqual([16.5]);
    expect(ing(323076, 'other-tocopherols').label_name).toBe('D-Gamma-Tocopherol');
    expect(ing(323076, 'boron').per_serving).toEqual({ amount: 2, unit: 'mg' });
  });

  it('306412 and 67231: vitamin E 400 IU, synthetic in mg vs natural in IU', () => {
    expect(ing(306412, 'vitamin-e')).toMatchObject({ form_kind: 'synthetic', per_serving: { amount: 268, unit: 'mg' } });
    expect(ing(67231, 'vitamin-e')).toMatchObject({ form_kind: 'natural', label_amount: { amount: 400, unit: 'IU' }, per_serving: { amount: 268, unit: 'mg' } });
  });

  it('334468 a magnesium blend nested under "Magnesium 500 mg" is a form breakdown, not a gap', () => {
    const l = normalizedFixture(334468);
    expect(l.ingredients.filter((i) => i.nutrient_id === 'magnesium').map((i) => i.per_serving)).toEqual([{ amount: 500, unit: 'mg' }]);
    expect(l.data_gaps).toEqual([]);
    expect(l.unrecognized_ingredients.map((u) => u.label_name)).toEqual(['Humic/Fulvic Monoatomic Blend']);
  });

  it('332278 proprietary blend with unquantified melatonin is a BLEND_UNQUANTIFIED gap', () => {
    const l = normalizedFixture(332278);
    expect(l.serving).toMatchObject({ quantity: 7.7, unit: 'Gram(s)' });
    expect(l.data_gaps.map((g) => g.code)).toEqual(['BLEND_UNQUANTIFIED']);
    expect(ing(332278, 'magnesium').per_serving).toEqual({ amount: 325, unit: 'mg' });
  });

  it('74373 off-market vitamin A from fish liver oil converts as preformed', () => {
    const l = normalizedFixture(74373);
    expect(l.on_market).toBe(false);
    expect(ing(74373, 'vitamin-a')).toMatchObject({ form_kind: 'preformed', per_serving: { amount: 3000, unit: 'mcg RAE' }, toward_ul_per_serving: 3000 });
  });

  it('284181 uses the label daily maximum of 3 servings', () => {
    expect(normalizedFixture(284181).serving.daily_servings).toEqual({ min: 1, max: 3 });
  });
});

describe('golden: real stack', () => {
  const app = testApp();
  afterAll(() => app.close());

  it('D3 5000 IU + women\'s multivitamin + Natrol Magnesium Night + custom magnesium, woman aged 34', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/stack/analyze',
      payload: {
        age: 34,
        sex: 'female',
        products: [{ dsld_id: 230932 }, { dsld_id: 338022 }, { dsld_id: 332278 }, { name: 'Custom magnesium', ingredients: [{ name: 'magnesium', amount: 250, unit: 'mg' }] }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const t = (id: string) => body.nutrient_totals.find((x: { nutrient_id: string }) => x.nutrient_id === id);
    expect(t('vitamin-d')).toMatchObject({ daily_total: { amount: 150, unit: 'mcg' }, flags: ['above_ul'], percent_of_ul: 150 });
    expect(t('magnesium')).toMatchObject({ daily_total: { amount: 575, unit: 'mg' }, flags: ['above_ul'] });
    expect(t('folate')).toMatchObject({ amount_toward_ul: { amount: 480, unit: 'mcg folic acid' }, flags: [] });
    expect(t('vitamin-a')).toMatchObject({ amount_toward_ul: { amount: 0, unit: 'mcg' }, percent_of_ul: 0, complete: true });
    const stable = JSON.stringify(body).replace(/"(as_of|retrieved)":"\d{4}-\d{2}-\d{2}"/g, '"$1":"<date>"');
    await expect(`${JSON.stringify(JSON.parse(stable), null, 2)}\n`).toMatchFileSnapshot('golden/stack-real-4-products.json');
  });
});
