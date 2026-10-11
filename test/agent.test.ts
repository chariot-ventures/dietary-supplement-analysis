import { afterAll, describe, expect, it } from 'vitest';
import { analyzeStack } from '../src/lib/analyze.js';
import { agentSummary, suggestFixes } from '../src/lib/advise.js';
import { groupVersions, matchScore, rankCandidates, tokens } from '../src/lib/catalog.js';
import { formatUpcForDsld, normalizeUpc, type SearchHit } from '../src/lib/dsld.js';
import { normalizeCustomProduct } from '../src/lib/label.js';
import { normalizedFixture, testApp } from './helpers.js';

const app = testApp();
afterAll(() => app.close());
const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as Record<string, unknown> });
const FORBIDDEN_WORDING = [/\bsafe\b/i, /\bno risk\b/i, /\bno interactions\b/i];
const female62 = { age: 62, sex: 'female' as const };

const hit = (id: number, name: string, entry: string | null, onMarket = true, brand = 'Fixture Labs'): SearchHit => ({
  id,
  name,
  brand,
  upc: null,
  entry_date: entry,
  on_market: onMarket,
});

describe('catalog: versions, matching, barcodes', () => {
  it('groups label versions by brand and name; newest on-market version first', () => {
    const groups = groupVersions([hit(1, 'Zinc 50 mg', '2018-01-01'), hit(2, 'Magnesium', '2020-01-01'), hit(3, 'Zinc 50 MG', '2023-01-01'), hit(4, 'Zinc 50 mg', '2025-01-01', false)]);
    expect(groups.map((g) => g.primary.id)).toEqual([3, 2]);
    expect(groups[0]!.others.map((o) => o.id)).toEqual([1, 4]);
  });

  it('matches words regardless of apostrophes, plurals and "50+"', () => {
    expect(tokens("Women's 50+ Multivitamins")).toEqual(['women', '50', 'multivitamin']);
    expect(matchScore('centrum silver womens 50+', { brand: 'Centrum', name: 'Centrum Silver Women 50+' })).toBe(1);
    expect(matchScore('nature made fish oil', { brand: 'Nature Made', name: 'Ultra Fish Oil 1400 mg' })).toBe(1);
    expect(matchScore('thorne zinc', { brand: 'Thorne', name: 'Magnesium Bisglycinate' })).toBe(0.5);
  });

  it('confidence: high for a unique full match, medium when several match, low under 60%', () => {
    expect(rankCandidates('zinc 50', undefined, [hit(1, 'Zinc 50 mg', null), hit(2, 'Magnesium', null)]).confidence).toBe('high');
    const two = rankCandidates('zinc', undefined, [hit(1, 'Zinc 50 mg', null), hit(2, 'Zinc Picolinate', null)]);
    expect(two.confidence).toBe('medium');
    expect(two.chosen!.dsld_id).toBe(1); // DSLD's relevance order breaks the tie
    expect(two.alternatives[0]!.dsld_id).toBe(2);
    expect(rankCandidates('acme super sleep gummies', undefined, [hit(1, 'Zinc 50 mg', null)]).confidence).toBe('low');
    expect(rankCandidates('anything', undefined, []).chosen).toBeNull();
  });

  it('formats UPC-A the way DSLD stores it; EAN-13 with a leading 0 is the same code', () => {
    expect(formatUpcForDsld('031604026974')).toBe('0 31604 02697 4');
    expect(normalizeUpc('0-31604-02697-4')).toBe('031604026974');
    expect(normalizeUpc('0031604026974')).toBe('031604026974');
    expect(formatUpcForDsld('1234567')).toBeNull();
  });
});

describe('POST /v1/products/search: version dedupe', () => {
  it('returns one result per product, newest version, with other_versions', async () => {
    const res = await post('/v1/products/search', { query: 'zinc 50' });
    expect(res.statusCode).toBe(200);
    const zinc = res.json().products.filter((p: { name: string }) => p.name === 'Zinc 50 mg');
    expect(zinc).toHaveLength(1);
    expect(zinc[0]).toMatchObject({ dsld_id: 900007, entry_date: '2023-06-01', other_versions: [900006] });
  });

  it('dedupe_versions: false lists every version', async () => {
    const res = await post('/v1/products/search', { query: 'zinc 50', dedupe_versions: false });
    expect(res.json().products.filter((p: { name: string }) => p.name === 'Zinc 50 mg')).toHaveLength(2);
  });
});

describe('POST /v1/products/lookup', () => {
  it('finds the newest label for a barcode, ignoring spaces and dashes', async () => {
    const res = await post('/v1/products/lookup', { upc: '0-12345-67890-5' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ upc: '012345678905', dsld_id: 900007, other_versions: [{ dsld_id: 900006, entry_date: '2018-01-10' }] });
    expect(body.product.ingredients[0]).toMatchObject({ nutrient_id: 'zinc', label_amount: { amount: 50, unit: 'mg' } });
  });

  it('404 NOT_FOUND for an unknown barcode, 400 for a malformed one', async () => {
    expect((await post('/v1/products/lookup', { upc: '099999999999' })).json().error).toMatchObject({ code: 'NOT_FOUND', field: 'upc' });
    expect((await post('/v1/products/lookup', { upc: 'abc-12' })).statusCode).toBe(400);
  });
});

describe('POST /v1/stack/analyze: one call from what the user said', () => {
  it('resolves names and barcodes, records how, and analyzes', async () => {
    const res = await post('/v1/stack/analyze', { ...female62, products: [{ query: 'Fixture Labs Daily Multivitamin' }, { upc: '012345678905' }] });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.resolutions).toEqual([
      expect.objectContaining({ input_path: 'products.0', status: 'resolved', matched_by: 'query', dsld_id: 900002, product_ref: 'dsld:900002', confidence: 'high' }),
      expect.objectContaining({ input_path: 'products.1', status: 'resolved', matched_by: 'upc', dsld_id: 900007, other_versions: [900006] }),
    ]);
    expect(body.products.map((p: { product_ref: string }) => p.product_ref)).toEqual(['dsld:900002', 'dsld:900007']);
    expect(body.nutrient_totals[0]).toMatchObject({ nutrient_id: 'zinc', flags: ['above_ul'], severity: 'high' });
  });

  it('a product that cannot be identified is reported and skipped, not fatal', async () => {
    const res = await post('/v1/stack/analyze', { ...female62, products: [{ dsld_id: 900001 }, { query: 'qqq nonexistent widget' }] });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary).toMatchObject({ products_matched: 1, products_unresolved: 1 });
    expect(body.resolutions[0]).toMatchObject({ status: 'not_found', input: { query: 'qqq nonexistent widget' } });
    expect(body.data_gaps[0]).toMatchObject({ code: 'PRODUCT_NOT_RESOLVED' });
    expect(body.agent_summary).toMatch(/Not identified, so not counted: "qqq nonexistent widget"/);
  });

  it('404 when no product can be identified', async () => {
    const res = await post('/v1/stack/analyze', { products: [{ query: 'qqq nonexistent widget' }, { upc: '099999999999' }] });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatchObject({ code: 'NOT_FOUND', field: 'products' });
  });
});

describe('suggestions', () => {
  it('no reduce_servings option when even one serving stays over the UL; removal comes first', () => {
    // Zinc 50 mg at the label maximum of 2 a day (100 mg) plus a multivitamin's zinc.
    const a = analyzeStack([{ label: normalizedFixture(900007) }, { label: normalizedFixture(900002), servings_per_day: 1 }], female62);
    const zinc = suggestFixes(a).filter((s) => s.nutrient_id === 'zinc');
    expect(zinc.some((s) => s.action === 'reduce_servings')).toBe(false); // 50 mg in one serving is still over 40 mg
    expect(zinc[0]).toMatchObject({ action: 'remove_product', product_ref: 'dsld:900007', resolves: true });
    expect(a.products[0]).toMatchObject({ servings_per_day_used: 2, servings_source: 'label_maximum' });
  });

  it('reduce_servings when one fewer serving is enough', () => {
    const p = normalizeCustomProduct('custom:1', 'Zinc 15', [{ name: 'zinc', amount: 15, unit: 'mg' }]);
    const a = analyzeStack([{ label: p, servings_per_day: 3 }], female62); // 45 mg vs UL 40
    const [first] = suggestFixes(a);
    expect(first).toMatchObject({ action: 'reduce_servings', servings_per_day: 2, resolves: true, result: { amount_toward_ul: { amount: 30, unit: 'mg' }, percent_of_ul: 75 } });
    expect(first!.text).toBe('Taking 2 servings a day of Zinc 15 instead of 3 would bring zinc to 30 mg (75% of the UL).');
  });

  it('a removal that fixes two nutrients at once ranks first and says so', () => {
    const both = normalizeCustomProduct('custom:1', 'Mega', [
      { name: 'zinc', amount: 45, unit: 'mg' },
      { name: 'magnesium', amount: 400, unit: 'mg' },
    ]);
    const zincOnly = normalizeCustomProduct('custom:2', 'Zinc 45', [{ name: 'zinc', amount: 45, unit: 'mg' }]);
    const a = analyzeStack([{ label: both }, { label: zincOnly }], female62);
    const zinc = suggestFixes(a).filter((s) => s.nutrient_id === 'zinc');
    expect(zinc.every((s) => !s.resolves)).toBe(true); // either removal leaves 45 mg
    const mg = suggestFixes(a).find((s) => s.nutrient_id === 'magnesium')!;
    expect(mg).toMatchObject({ product_ref: 'custom:1', resolves: true, also_resolves: [] });
  });
});

describe('candidates: what changes if I add this?', () => {
  it('reports new above-UL flags for a candidate, without counting it in the totals', async () => {
    const res = await post('/v1/stack/analyze', { age: 34, sex: 'female', products: [{ dsld_id: 900002 }], candidates: [{ dsld_id: 900001 }, { dsld_id: 900003 }] });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const vitD = body.nutrient_totals.find((t: { nutrient_id: string }) => t.nutrient_id === 'vitamin-d');
    expect(vitD.flags).toEqual([]);
    expect(body.candidate_results[0]).toMatchObject({ product_ref: 'dsld:900001', verdict: 'adds_above_ul', new_flags: [{ nutrient_id: 'vitamin-d', flag: 'above_ul' }] });
    expect(body.candidate_results[1].product_ref).toBe('dsld:900003');
    expect(body.agent_summary).toMatch(/Adding Fixture Labs Vitamin D3 5000 IU would put Vitamin D \(\d+% of the UL\) above the upper limit/);
  });
});

describe('agent_summary', () => {
  it('without a profile, says totals were not compared', () => {
    const a = analyzeStack([{ label: normalizedFixture(900001) }], null);
    expect(agentSummary(a, { suggestions: [], unresolved: [], lowConfidence: [], candidates: [] })).toMatch(/without age and sex, totals were not compared with upper limits/);
  });

  it('with nothing flagged, says so without calling the stack safe', () => {
    const a = analyzeStack([{ label: normalizedFixture(900003) }], { age: 40, sex: 'male' });
    const text = agentSummary(a, { suggestions: [], unresolved: [], lowConfidence: [], candidates: [] });
    expect(text).toMatch(/^No nutrient in these supplements is above its upper limit \(UL\) for a 40-year-old male\./);
    for (const re of FORBIDDEN_WORDING) expect(text).not.toMatch(re);
  });

  it('mentions suspect label data', () => {
    const a = analyzeStack([{ label: normalizedFixture(900008) }], female62);
    expect(a.summary.data_suspect).toBe(1);
    expect(agentSummary(a, { suggestions: [], unresolved: [], lowConfidence: [], candidates: [] })).toMatch(/1 label entry looks inconsistent/);
  });
});

describe('DATA_SUSPECT: label records that look wrong', () => {
  it('duplicate rows (EPA entered as DHA), both still counted', () => {
    const l = normalizedFixture(900008);
    expect(l.data_gaps).toEqual([expect.objectContaining({ code: 'DATA_SUSPECT', check: 'duplicate_row', nutrient_id: 'dha' })]);
    expect(l.ingredients.filter((i) => i.nutrient_id === 'dha').map((i) => i.per_serving?.amount)).toEqual([683, 252]);
  });

  it('the same nutrient listed twice with different forms is not suspect', async () => {
    const { makeLabel, q } = await import('./helpers.js');
    const { normalizeDsldLabel } = await import('../src/lib/label.js');
    const l = makeLabel(1, [
      { name: 'Calcium', ingredientGroup: 'Calcium', forms: [{ name: 'Calcium Carbonate' }], quantity: q(200, 'mg') },
      { name: 'Calcium', ingredientGroup: 'Calcium', forms: [{ name: 'Calcium Citrate' }], quantity: q(100, 'mg') },
    ]);
    expect(normalizeDsldLabel(l).data_gaps.filter((g) => g.code === 'DATA_SUSPECT')).toEqual([]);
  });

  it('%DV that contradicts the amount, implausible amounts, and nested rows larger than their total', () => {
    const checks = normalizedFixture(900009).data_gaps.map((g) => [g.check, g.nutrient_id ?? null]);
    expect(checks).toEqual([
      ['percent_dv_mismatch', 'magnesium'],
      ['implausible_amount', 'selenium'],
      ['nested_exceeds_parent', null],
    ]);
  });

  it('no false positives on the recorded real labels', async () => {
    const { fixtureLabels } = await import('./helpers.js');
    const { normalizeDsldLabel } = await import('../src/lib/label.js');
    const real = [...fixtureLabels.keys()].filter((id) => id < 900000);
    for (const id of real) {
      const gaps = normalizeDsldLabel(structuredClone(fixtureLabels.get(id)!)).data_gaps.filter((g) => g.code === 'DATA_SUSPECT');
      expect({ id, gaps }).toEqual({ id, gaps: [] });
    }
  });
});

describe('discovery for agents', () => {
  it('GET /v1/tools lists every operation with a JSON Schema input', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/tools' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tools.map((t: { name: string }) => t.name)).toEqual(['stack_analyze', 'products_search', 'products_lookup', 'products_get', 'nutrients_reference']);
    for (const t of body.tools) {
      expect(t.input_schema.type).toBe('object');
      expect(t.description.length).toBeGreaterThan(40);
      // Every tool is reachable through the dispatcher too.
      expect((await post('/v1/tool', { tool: t.name, arguments: {} })).statusCode).toBeLessThan(500);
    }
  });

  it('GET /v1/guide wraps the markdown guide in a JSON object', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/guide' });
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.json().guide).toMatch(/POST \/v1\/stack\/analyze/);
  });

  it('the dispatcher routes products_lookup', async () => {
    const res = await post('/v1/tool', { tool: 'products_lookup', arguments: { upc: '012345678905' } });
    expect(res.json().dsld_id).toBe(900007);
  });
});

describe('life stages and new nutrients', () => {
  const ref = async (nutrient: string, age: number, sex: string, life_stage?: string) =>
    (await post('/v1/nutrients/reference', { nutrient, age, sex, ...(life_stage ? { life_stage } : {}) })).json().reference;

  it('pregnancy and lactation tables', async () => {
    expect(await ref('folate', 30, 'female', 'pregnancy')).toMatchObject({ rda: 600, ul: 1000 });
    expect(await ref('iron', 17, 'female', 'pregnancy')).toMatchObject({ rda: 27, ul: 45 });
    expect(await ref('vitamin-a', 35, 'female', 'lactation')).toMatchObject({ rda: 1300, ul: 3000 });
    expect(await ref('phosphorus', 25, 'female', 'pregnancy')).toMatchObject({ rda: 700, ul: 3500 }); // the one pregnancy UL that differs
    expect(await ref('potassium', 30, 'female', 'pregnancy')).toMatchObject({ ai: 2900, ul: null });
  });

  it('infant tables by month', async () => {
    expect(await ref('vitamin-d', 0.25, 'male')).toMatchObject({ ai: 10, ul: 25 });
    expect(await ref('vitamin-d', 0.75, 'female')).toMatchObject({ ai: 10, ul: 38 });
    expect(await ref('iron', 2 / 12, 'female')).toMatchObject({ ai: 0.27, rda: null, ul: 40 });
    expect(await ref('iron', 9 / 12, 'female')).toMatchObject({ ai: null, rda: 11, ear: 6.9 });
  });

  it('caffeine guidance for adults and in pregnancy; none set under 19', async () => {
    expect(await ref('caffeine', 30, 'male')).toMatchObject({ ul: 400, ul_scope: 'guidance_healthy_adults' });
    expect(await ref('caffeine', 30, 'female', 'pregnancy')).toMatchObject({ ul: 200 });
    expect(await ref('caffeine', 16, 'female')).toMatchObject({ ul: null });
  });

  it('sodium uses the CDRR and says so; chloride and fluoride have DRIs', async () => {
    const na = await ref('sodium', 40, 'male');
    expect(na).toMatchObject({ ai: 1500, ul: 2300, ul_scope: 'chronic_disease_risk_reduction' });
    expect(na.ul_note).toMatch(/no UL/);
    expect(await ref('chloride', 40, 'female')).toMatchObject({ ai: 2300, ul: 3600 });
    expect(await ref('fluoride', 40, 'male')).toMatchObject({ ai: 4, ul: 10 });
  });

  it('a prenatal stack is checked against pregnancy values and described that way', async () => {
    const res = await post('/v1/stack/analyze', {
      age: 30,
      sex: 'female',
      life_stage: 'pregnancy',
      products: [{ name: 'Prenatal', ingredients: [{ name: 'folate', amount: 1360, unit: 'mcg DFE', form: 'folic acid' }, { name: 'iron', amount: 27, unit: 'mg' }] }, { name: 'Pre-workout', ingredients: [{ name: 'caffeine anhydrous', amount: 300, unit: 'mg' }] }],
    });
    const body = res.json();
    expect(body.profile).toEqual({ age: 30, sex: 'female', life_stage: 'pregnancy' });
    const t = (id: string) => body.nutrient_totals.find((x: { nutrient_id: string }) => x.nutrient_id === id);
    expect(t('iron')).toMatchObject({ coverage: { reference: 'rda', percent: 100 }, flags: [] });
    expect(t('folate')).toMatchObject({ amount_toward_ul: { amount: 800 }, percent_of_ul: 80, flags: [] });
    expect(t('caffeine')).toMatchObject({ flags: ['above_ul'], percent_of_ul: 150 });
    expect(body.agent_summary).toMatch(/for a pregnant 30-year-old/);
  });

  it('pregnant: true is accepted as an alias for life_stage', async () => {
    const res = await post('/v1/nutrients/reference', { nutrient: 'iodine', age: 28, sex: 'female', pregnant: true });
    expect(res.json()).toMatchObject({ profile: { life_stage: 'pregnancy' }, reference: { rda: 220 } });
  });
});

describe('diet: "typical"', () => {
  it('adds US average food intake and flags what supplements alone did not', async () => {
    // 1,200 mg calcium from supplements: 92% of the 1,300 mg RDA alone; with ~825 mg from food it passes the 2,000 mg UL (age 62).
    const res = await post('/v1/stack/analyze', {
      age: 62,
      sex: 'female',
      diet: 'typical',
      products: [{ name: 'Calcium', ingredients: [{ name: 'calcium', amount: 1200, unit: 'mg' }, { name: 'magnesium', amount: 300, unit: 'mg' }] }],
    });
    const body = res.json();
    const ca = body.nutrient_totals.find((t: { nutrient_id: string }) => t.nutrient_id === 'calcium');
    expect(ca.flags).toEqual([]);
    expect(ca.with_typical_diet).toMatchObject({ food: { amount: 825, unit: 'mg' }, estimated_total: { amount: 2025 }, flags: ['above_ul'] });
    // Magnesium's UL covers supplements only, so food adds to the total but not to the UL comparison.
    const mg = body.nutrient_totals.find((t: { nutrient_id: string }) => t.nutrient_id === 'magnesium');
    expect(mg.with_typical_diet).toMatchObject({ estimated_total: { amount: 573 }, amount_toward_ul: { amount: 300 }, flags: [] });
    expect(body.summary).toMatchObject({ diet_estimates: 2, diet_only_flags: 1 });
    expect(body.agent_summary).toMatch(/With average US food and drink intake added, Calcium would be above its UL \(101%\)\./);
    expect(body.agent_summary).toMatch(/the food estimate is a US average/);
    expect(body.sources.map((s: { url: string }) => s.url)).toContain('https://www.ars.usda.gov/ARSUserFiles/80400530/pdf/1720/Table_1_NIN_MaleFemale_1720.pdf');
  });

  it('folate counts food folic acid toward the UL, not food folate', async () => {
    const res = await post('/v1/stack/analyze', { age: 25, sex: 'male', diet: 'typical', products: [{ name: 'B', ingredients: [{ name: 'folate', amount: 1360, unit: 'mcg DFE', form: 'folic acid' }] }] });
    const f = res.json().nutrient_totals[0];
    expect(f.with_typical_diet).toMatchObject({ food: { amount: 582 }, amount_toward_ul: { amount: 1017 }, flags: ['above_ul'] });
  });

  it('is not applied for pregnancy or under age 2, and says why', async () => {
    const res = await post('/v1/stack/analyze', { age: 30, sex: 'female', life_stage: 'pregnancy', diet: 'typical', products: [{ dsld_id: 900001 }] });
    const body = res.json();
    expect(body.nutrient_totals[0].with_typical_diet).toBeUndefined();
    expect(body.assumptions.join(' ')).toMatch(/diet "typical" was not applied/);
  });
});

describe('detail: "summary" and provenance', () => {
  it('returns a compact answer with the flagged nutrients only', async () => {
    const payload = { age: 62, sex: 'female', products: [{ dsld_id: 900007 }, { dsld_id: 900002, servings_per_day: 1 }], candidates: [{ dsld_id: 900001 }] };
    const full = await post('/v1/stack/analyze', payload);
    const res = await post('/v1/stack/analyze', { ...payload, detail: 'summary' });
    const body = res.json();
    expect(body.detail).toBe('summary');
    expect(body.flagged.map((f: { nutrient_id: string }) => f.nutrient_id)).toEqual(['zinc']);
    expect(body.flagged[0]).toMatchObject({ severity: 'high', ul: 40, ul_basis: expect.stringMatching(/copper/) });
    expect(body.suggestions[0]).toMatchObject({ action: 'remove_product', resolves: true });
    expect(body.candidate_results[0]).toMatchObject({ verdict: expect.any(String), text: expect.any(String) });
    expect(body.agent_summary).toBe(full.json().agent_summary);
    expect(body.nutrient_totals).toBeUndefined();
    expect(res.body.length).toBeLessThan(full.body.length / 4);
  });

  it('every analysis says which code and data produced it; /v1/provenance has the detail', async () => {
    const res = await post('/v1/stack/analyze', { products: [{ dsld_id: 900001 }] });
    expect(res.json().provenance).toMatchObject({ version: expect.any(String), reference_values_reviewed: expect.any(String) });
    const p = (await app.inject({ method: 'GET', url: '/v1/provenance' })).json();
    expect(p).toMatchObject({ service: 'dietary-supplement-analysis', data: { typical_intake: { name: expect.stringMatching(/What We Eat in America/) } } });
  });
});
