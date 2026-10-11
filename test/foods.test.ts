import { afterAll, describe, expect, it } from 'vitest';
import { getFood, gramsFor, nutrientsIn, searchFoods } from '../src/lib/foods.js';
import { testApp } from './helpers.js';

const app = testApp();
afterAll(() => app.close());
const analyze = async (payload: unknown) => (await app.inject({ method: 'POST', url: '/v1/stack/analyze', payload: payload as Record<string, unknown> })).json();

describe('USDA SR28 food table', () => {
  it('carries the published SR28 values per 100 g', () => {
    const spinach = getFood('11458')!;
    expect(spinach[1]).toBe('Spinach, cooked, boiled, drained, without salt');
    const n = nutrientsIn(spinach, 100).nutrients;
    const v = (id: string) => n.find((x) => x.nutrient_id === id)?.amount;
    expect(v('calcium')).toBe(136);
    expect(v('iron')).toBe(3.57);
    expect(v('vitamin-k')).toBe(493.6);
    expect(v('folate')).toBe(146);
  });

  it('keeps "not analyzed" apart from zero', () => {
    const salmon = getFood('15076')!; // vitamin D and K are blank in SR28 for this entry
    const r = nutrientsIn(salmon, 100);
    expect(r.not_analyzed).toEqual(expect.arrayContaining(['vitamin-d', 'vitamin-k']));
    expect(r.nutrients.find((x) => x.nutrient_id === 'vitamin-d')).toBeUndefined();
  });

  it('counts only the UL-relevant part of food: retinol for vitamin A, folic acid for folate, nothing for magnesium', () => {
    const n = nutrientsIn(getFood('11124')!, 100).nutrients; // raw carrots: 835 mcg RAE, all carotenoids
    expect(n.find((x) => x.nutrient_id === 'vitamin-a')).toMatchObject({ amount: 835, toward_ul: 0 });
    const m = nutrientsIn(getFood('11458')!, 100).nutrients.find((x) => x.nutrient_id === 'magnesium');
    expect(m).toMatchObject({ amount: 87, toward_ul: 0 });
  });

  it('excludes the implausible SR28 manganese values', () => {
    const r = nutrientsIn(getFood('23425')!, 100);
    expect(r.nutrients.find((x) => x.nutrient_id === 'manganese')).toBeUndefined();
    expect(r.suspect[0]!.nutrient).toBe('manganese');
  });
});

describe('food matching', () => {
  it.each([
    ['whole milk', '01077'],
    ['spinach cooked', '11458'],
    ['eggs', '01123'],
    ['banana', '09040'],
    ['almonds', '12061'],
    ['brazil nuts', '12078'],
    ['cheddar cheese', '01009'],
    ['beef liver', '13325'],
    ['coffee', '14209'],
  ])('"%s" -> %s', (q, ndb) => {
    expect(searchFoods(q).matches[0]?.ndb_number).toBe(ndb);
  });

  it('needs every word, so nonsense finds nothing', () => {
    expect(searchFoods('unicorn steak').matches).toEqual([]);
  });

  it('converts household portions and weights, and refuses portions USDA does not list', () => {
    const spinach = getFood('11458')!;
    expect(gramsFor(spinach, 1, 'cup')).toMatchObject({ ok: true, grams: 180, portion: '1 cup' });
    expect(gramsFor(spinach, 2, 'oz')).toMatchObject({ ok: true, grams: 56.7 });
    const bushel = gramsFor(getFood('09040')!, 1, 'bushel');
    expect(bushel.ok).toBe(false);
  });
});

describe('foods in stack_analyze', () => {
  it('adds the foods to the supplement totals in with_foods and flags what food pushes over the UL', async () => {
    const body = await analyze({
      age: 40,
      sex: 'female',
      products: [{ name: 'Multi', ingredients: [{ name: 'vitamin A', amount: 1500, unit: 'mcg RAE', form: 'retinyl palmitate' }] }],
      foods: [{ query: 'beef liver', amount: 3, unit: 'oz' }],
    });
    const a = body.nutrient_totals.find((t: { nutrient_id: string }) => t.nutrient_id === 'vitamin-a');
    expect(a.flags).toEqual([]);
    expect(a.with_foods.flags).toEqual(['above_ul']);
    expect(body.foods.items[0]).toMatchObject({ status: 'resolved', ndb_number: '13325', grams: 85.05 });
    expect(body.agent_summary).toMatch(/With the foods listed added, Vitamin A would be above its UL/);
    expect(body.sources.map((s: { name: string }) => s.name).join(' ')).toMatch(/Standard Reference, Release 28/);
  });

  it('checks food-only nutrients against the UL too', async () => {
    const body = await analyze({ age: 40, sex: 'female', products: [{ name: 'C', ingredients: [{ name: 'vitamin C', amount: 100, unit: 'mg' }] }], foods: [{ query: 'brazil nuts', grams: 60 }] });
    const se = body.foods.totals.find((t: { nutrient_id: string }) => t.nutrient_id === 'selenium');
    expect(se.flags).toEqual(['above_ul']);
    expect(body.agent_summary).toMatch(/Selenium would be above its UL/);
  });

  it('reports foods it could not count, with the portions USDA does list', async () => {
    const body = await analyze({ age: 40, sex: 'female', products: [{ name: 'Z', ingredients: [{ name: 'zinc', amount: 5, unit: 'mg' }] }], foods: [{ query: 'unicorn steak', grams: 100 }, { query: 'banana', amount: 1, unit: 'bushel' }] });
    const codes = body.data_gaps.map((g: { code: string }) => g.code);
    expect(codes).toEqual(expect.arrayContaining(['FOOD_NOT_RESOLVED', 'FOOD_PORTION_UNKNOWN']));
    expect(body.foods.items[1].portions.length).toBeGreaterThan(0);
  });

  it('rejects foods together with diet "typical", and malformed amounts', async () => {
    const both = await app.inject({ method: 'POST', url: '/v1/stack/analyze', payload: { age: 40, sex: 'female', diet: 'typical', products: [{ dsld_id: 900001 }], foods: [{ query: 'egg', grams: 50 }] } });
    expect(both.statusCode).toBe(400);
    const noAmount = await app.inject({ method: 'POST', url: '/v1/stack/analyze', payload: { age: 40, sex: 'female', products: [{ dsld_id: 900001 }], foods: [{ query: 'egg' }] } });
    expect(noAmount.statusCode).toBe(400);
  });
});

describe('timing tips', () => {
  it('gives the NIH timing statements that apply, with sources', async () => {
    const body = await analyze({
      age: 55,
      sex: 'female',
      medications: ['levothyroxine'],
      products: [
        { name: 'Cal', ingredients: [{ name: 'calcium carbonate', amount: 600, unit: 'mg', nutrient_basis: 'elemental' }, { name: 'vitamin D3', amount: 1000, unit: 'IU' }] },
        { name: 'Iron', ingredients: [{ name: 'iron', amount: 27, unit: 'mg' }] },
        { name: 'Zinc', ingredients: [{ name: 'zinc', amount: 15, unit: 'mg' }] },
      ],
    });
    const ids = body.timing.map((t: { id: string }) => t.id);
    expect(ids).toEqual(expect.arrayContaining(['calcium_dose_size', 'calcium_carbonate_with_food', 'calcium_iron_apart', 'iron_zinc_apart', 'vitamin_d_with_fat', 'medication_timing']));
    expect(ids).not.toContain('iron_with_food'); // 27 mg a day is under the 45 mg GI threshold
    for (const t of body.timing) expect(t.source.url).toMatch(/^https:\/\/ods\.od\.nih\.gov\//);
    expect(body.agent_summary).toMatch(/Timing \(1 of \d+ tips in timing\): Calcium is absorbed best in doses of 500 mg or less/);
  });

  it('gives no tips for a stack they do not apply to', async () => {
    const body = await analyze({ age: 30, sex: 'male', products: [{ name: 'C', ingredients: [{ name: 'vitamin C', amount: 250, unit: 'mg' }] }] });
    expect(body).not.toHaveProperty('timing');
  });
});
