import { afterAll, describe, expect, it } from 'vitest';
import bdata from '../data/botanicals.json' with { type: 'json' };
import idata from '../data/interactions.json' with { type: 'json' };
import { firstSentence } from '../src/lib/advise.js';
import { matchBotanical, nameForms } from '../src/lib/botanicals.js';
import { nutrientIndex } from '../src/lib/nutrients.js';
import { testApp } from './helpers.js';

const app = testApp();
afterAll(() => app.close());
const analyze = async (payload: unknown) => (await app.inject({ method: 'POST', url: '/v1/stack/analyze', payload: payload as Record<string, unknown> })).json();
const custom = (ingredients: { name: string; amount: number; unit: string }[], servings_per_day = 1) => ({ name: 'Herbal', servings_per_day, ingredients });

describe('botanical data file', () => {
  it('cites NIH for every entry, uses known drug classes, and never clashes with a nutrient name', () => {
    for (const [id, b] of Object.entries(bdata.botanicals)) {
      expect(b.source.url, id).toMatch(/^https:\/\/(www\.nccih\.nih\.gov|ods\.od\.nih\.gov)\//);
      for (const m of b.medications) expect(Object.keys(idata.drug_classes), `${id}: ${m.class}`).toContain(m.class);
      for (const name of b.match) expect(nutrientIndex.resolve(name), `${id}: ${name}`).toBeUndefined();
      for (const s of b.signals) expect(s.summary).not.toMatch(/\bsafe\b|no risk/i);
    }
  });

  it('has every drug class used by a nutrient or botanical interaction', () => {
    const used = new Set([...idata.interactions.map((i) => i.class), ...Object.values(bdata.botanicals).flatMap((b) => b.medications.map((m) => m.class))]);
    expect(Object.keys(idata.drug_classes).filter((c) => !used.has(c))).toEqual([]);
  });
});

describe('botanical matching', () => {
  it('drops trailing plant-part and preparation words only', () => {
    expect(nameForms('Organic Ashwagandha Root Extract')).toEqual(['ashwagandha root extract', 'ashwagandha root', 'ashwagandha']);
    expect(matchBotanical(['Ashwagandha Root Extract'])?.id).toBe('ashwagandha');
    expect(matchBotanical(["St. John's Wort (aerial parts) extract"])?.id).toBe('st-johns-wort');
    expect(matchBotanical(['Green Tea Leaf Extract'])?.id).toBe('green-tea-extract');
  });

  it('prefers the DSLD ingredient group and never matches substrings', () => {
    expect(matchBotanical(['Ashwagandha', 'KSM-66 root'])?.id).toBe('ashwagandha');
    expect(matchBotanical(['Garcinia mangostana fruit'])).toBeNull();
    expect(matchBotanical(['Turmeric-free blend'])).toBeNull();
    expect(matchBotanical(['Creatinine'])).toBeNull();
  });

  it('splits sentences without breaking on "St."', () => {
    expect(firstSentence("NCCIH: St. John's wort can weaken drugs. Second.")).toBe("NCCIH: St. John's wort can weaken drugs.");
  });
});

describe('botanicals in stack_analyze', () => {
  it('lists green tea in a multivitamin without relaying its extract warning', async () => {
    const body = await analyze({ age: 40, sex: 'female', products: [custom([{ name: 'green tea leaf extract', amount: 50, unit: 'mg' }])] });
    expect(body.botanicals[0].id).toBe('green-tea-extract');
    expect(body.agent_summary).not.toMatch(/green tea/i);
  });

  it('reports detected botanicals with signals and sources, without needing medications', async () => {
    const body = await analyze({ age: 40, sex: 'female', products: [custom([{ name: 'Ashwagandha root extract', amount: 600, unit: 'mg' }, { name: 'zinc', amount: 10, unit: 'mg' }])] });
    expect(body.botanicals).toHaveLength(1);
    expect(body.botanicals[0]).toMatchObject({ id: 'ashwagandha', product_refs: ['custom:1'], label_names: ['Ashwagandha root extract'] });
    expect(body.botanicals[0].signals[0].kind).toBe('liver_injury');
    expect(body.summary.botanicals_with_signals).toBe(1);
    expect(body.sources.map((s: { url: string }) => s.url)).toContain('https://www.nccih.nih.gov/health/ashwagandha');
    expect(body.agent_summary).toMatch(/Ashwagandha \(in Herbal\): NCCIH: although rare/);
    // Not repeated as an unrecognized ingredient problem; still listed there for completeness.
    expect(body.unrecognized_ingredients.map((u: { label_name: string }) => u.label_name)).toContain('Ashwagandha root extract');
  });

  it('adds the pregnancy statement for pregnancy and lactation only', async () => {
    const products = [custom([{ name: 'black cohosh', amount: 40, unit: 'mg' }])];
    expect((await analyze({ age: 30, sex: 'female', life_stage: 'pregnancy', products })).agent_summary).toMatch(/black cohosh may be unsafe during pregnancy/);
    expect((await analyze({ age: 30, sex: 'female', products })).agent_summary).not.toMatch(/pregnan/);
  });

  it('checks creatine against the doses NIH ODS cites, per day', async () => {
    const at = async (g: number, spd: number) => (await analyze({ age: 25, sex: 'male', products: [custom([{ name: 'creatine monohydrate', amount: g, unit: 'g' }], spd)] })).botanicals;
    expect(await at(5, 1)).toBeUndefined(); // no signal and within the maintenance dose: nothing to report
    const high = await at(5, 2);
    expect(high[0].dose_findings[0]).toMatchObject({ daily: { amount: 10000, unit: 'mg' } });
    expect(high[0].dose_findings[0].summary).toMatch(/3-5 g/);
    const veryHigh = await at(15, 2);
    expect(veryHigh[0].dose_findings).toHaveLength(1);
    expect(veryHigh[0].dose_findings[0].summary).toMatch(/25 g/);
  });

  it('counts only EGCG rows toward the EGCG dose, not the whole extract weight', async () => {
    const extractOnly = await analyze({ age: 50, sex: 'female', products: [custom([{ name: 'green tea extract', amount: 1000, unit: 'mg' }])] });
    expect(extractOnly.botanicals[0].dose_findings).toEqual([]);
    const egcg = await analyze({ age: 50, sex: 'female', products: [custom([{ name: 'green tea extract', amount: 1000, unit: 'mg' }, { name: 'EGCG', amount: 450, unit: 'mg' }], 2)] });
    expect(egcg.botanicals).toHaveLength(1);
    expect(egcg.botanicals[0].dose_findings[0].daily.amount).toBe(900);
  });

  it('turns botanical-medication pairs into in-stack interaction findings', async () => {
    const body = await analyze({
      age: 60,
      sex: 'female',
      medications: ['warfarin', 'sertraline', 'Yaz'],
      products: [custom([{ name: "St. John's wort", amount: 300, unit: 'mg' }, { name: 'ginkgo biloba leaf extract', amount: 120, unit: 'mg' }])],
    });
    const f = body.interactions.findings.filter((x: { botanical_ids: string[] }) => x.botanical_ids.length);
    const pairs = f.map((x: { trigger: string; botanical_ids: string[] }) => `${x.trigger}:${x.botanical_ids[0]}`).sort();
    expect(pairs).toEqual(['Yaz:st-johns-wort', 'sertraline:st-johns-wort', 'warfarin:ginkgo', 'warfarin:st-johns-wort']);
    expect(f.every((x: { in_stack: boolean }) => x.in_stack)).toBe(true);
    expect(body.agent_summary).toMatch(/with St\. John's wort in this stack/);
  });

  it('gives a compact list in the summary detail', async () => {
    const body = await analyze({ age: 40, sex: 'male', detail: 'summary', products: [custom([{ name: 'kava root', amount: 250, unit: 'mg' }])] });
    expect(body.botanicals[0]).toMatchObject({ id: 'kava', name: 'Kava' });
    expect(body.botanicals[0].signal).toMatch(/^NCCIH: kava products have been linked/);
  });
});

describe('interactions_check with botanicals', () => {
  it('lists botanical interactions for a medication and filters by botanical name', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/interactions/check', payload: { medications: ['warfarin'], nutrients: ['ginkgo'] } });
    const body = res.json();
    expect(body.findings).toHaveLength(1);
    expect(body.findings[0]).toMatchObject({ botanical_ids: ['ginkgo'], in_stack: false });
  });
});

describe('Spanish summaries', () => {
  it('translates every data phrase that can reach a summary', async () => {
    const { hasTranslation } = await import('../src/lib/summary-es.js');
    const { firstSentence } = await import('../src/lib/advise.js');
    const nut = (await import('../data/nutrients.json', { with: { type: 'json' } })).default as unknown as { nutrients: { name: string; ul_basis: string | null }[] };
    const phrases = new Set<string>();
    for (const n of nut.nutrients) [n.name, n.ul_basis].forEach((x) => x && phrases.add(x));
    for (const c of Object.values(idata.drug_classes)) phrases.add(c.name);
    for (const i of idata.interactions) [firstSentence(i.summary), i.timing].forEach((x) => x && phrases.add(x));
    for (const c of Object.values(idata.conditions)) {
      phrases.add(c.name.replace(/\s*\(.*\)$/, ''));
      for (const k of c.checks) phrases.add(firstSentence(k.summary));
    }
    for (const b of Object.values(bdata.botanicals)) {
      phrases.add(b.name);
      for (const s of b.signals) phrases.add(firstSentence(s.summary));
      if (b.pregnancy) phrases.add(firstSentence(b.pregnancy));
      for (const m of b.medications) phrases.add(firstSentence(m.summary));
      for (const d of (b as { dose_checks?: { summary: string }[] }).dose_checks ?? []) phrases.add(firstSentence(d.summary));
    }
    expect([...phrases].filter((p) => !hasTranslation(p))).toEqual([]);
  });

  it('writes agent_summary in Spanish and keeps the English one', async () => {
    const body = await analyze({ age: 40, sex: 'male', lang: 'es', medications: ['warfarina'], products: [custom([{ name: 'zinc', amount: 50, unit: 'mg' }, { name: 'vitamin K', amount: 100, unit: 'mcg' }, { name: 'ginkgo biloba', amount: 120, unit: 'mg' }])] });
    expect(body.lang).toBe('es');
    expect(body.agent_summary).toMatch(/^1 nutriente supera el nivel máximo de ingesta tolerable \(UL\) para un hombre de 40 años/);
    expect(body.agent_summary).toMatch(/Zinc: 50 mg al día frente a un UL de 40 mg \(125%\)\. El UL protege frente a: menor nivel de cobre/);
    expect(body.agent_summary).toMatch(/Warfarina con vitamina K de este conjunto: La vitamina K contrarresta la warfarina/);
    expect(body.agent_summary).toMatch(/Datos de etiquetas, no consejo médico\.$/);
    expect(body.agent_summary_en).toMatch(/^1 nutrient is above the upper limit/);
    expect(body.agent_summary).not.toMatch(/\bes seguro\b|sin riesgo/i);
  });

  it('is English by default with no extra fields', async () => {
    const body = await analyze({ age: 40, sex: 'male', products: [custom([{ name: 'zinc', amount: 5, unit: 'mg' }])] });
    expect(body).not.toHaveProperty('lang');
    expect(body).not.toHaveProperty('agent_summary_en');
  });
});
