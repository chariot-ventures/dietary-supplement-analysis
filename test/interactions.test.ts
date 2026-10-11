import { afterAll, describe, expect, it } from 'vitest';
import data from '../data/interactions.json' with { type: 'json' };
import { buildApp } from '../src/app.js';
import { classesForName, CONDITION_IDS, matchMedications, normalizeMedication, RxNormClient, type FetchLike } from '../src/lib/interactions.js';
import { nutrientIndex } from '../src/lib/nutrients.js';
import { fixtureClient, testApp } from './helpers.js';

const app = testApp();
afterAll(() => app.close());
const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as Record<string, unknown> });

const multi = (ingredients: { name: string; amount: number; unit: string }[]) => [{ name: 'Test multi', ingredients }];

describe('interaction data file', () => {
  it('uses only known nutrient IDs and drug classes, and cites an NIH ODS fact sheet for every entry', () => {
    const classes = new Set(Object.keys(data.drug_classes));
    for (const it of data.interactions) {
      expect(classes.has(it.class), it.class).toBe(true);
      for (const n of it.nutrients) expect(nutrientIndex.get(n), n).toBeDefined();
      expect(it.source.url).toMatch(/^https:\/\/ods\.od\.nih\.gov\/factsheets\//);
      expect(it.summary.toLowerCase()).not.toMatch(/\bsafe\b|no risk/);
    }
    for (const c of Object.values(data.conditions)) {
      for (const check of c.checks) {
        expect(nutrientIndex.get(check.nutrient), check.nutrient).toBeDefined();
        expect(check.source.url).toMatch(/^https:\/\/ods\.od\.nih\.gov\/factsheets\//);
      }
    }
    // Classes unused by any interaction are caught in botanicals.test.ts (which sees both files).
  });

  it('keeps member names lowercase and unique within a class', () => {
    for (const [id, c] of Object.entries(data.drug_classes)) {
      expect(new Set(c.members).size, id).toBe(c.members.length);
      for (const m of c.members) expect(m).toBe(m.toLowerCase());
    }
  });
});

describe('medication name matching', () => {
  it('normalizes strengths and punctuation', () => {
    expect(normalizeMedication('Synthroid® 50 mcg tablet')).toBe('synthroid tablet');
    expect(normalizeMedication('Metformin HCl 500mg')).toBe('metformin hcl');
  });

  it('matches generic and brand names as whole words only', () => {
    expect(classesForName('Lisinopril 10 mg')?.classes).toContain('ace_inhibitors');
    expect(classesForName('Coumadin')?.classes).toEqual(expect.arrayContaining(['vitamin_k_antagonists', 'anticoagulants']));
    expect(classesForName('levothyroxine sodium')?.member).toBe('levothyroxine');
    // No substring matching: "metformina" is not metformin, "ironwood" is not anything.
    expect(classesForName('metformina')).toBeNull();
    expect(classesForName('ironwood')).toBeNull();
  });

  it('falls back to RxNorm ingredients for names the list does not know, and caches them', async () => {
    const calls: string[] = [];
    const fake: FetchLike = async (url) => {
      calls.push(url);
      if (url.includes('approximateTerm')) return new Response(JSON.stringify({ approximateGroup: { candidate: [{ rxcui: '1234' }] } }));
      return new Response(JSON.stringify({ relatedGroup: { conceptGroup: [{ tty: 'IN', conceptProperties: [{ name: 'Levothyroxine' }] }] } }));
    };
    const rx = new RxNormClient(fake, 'https://rx.test');
    const [m] = await matchMedications(['Eltroxin'], rx);
    expect(m).toMatchObject({ status: 'matched', via: 'rxnorm', matched_name: 'levothyroxine' });
    await matchMedications(['Eltroxin'], rx);
    expect(calls).toHaveLength(2);
  });

  it('treats RxNorm failures as not recognized', async () => {
    const rx = new RxNormClient(async () => {
      throw new Error('offline');
    });
    const [m] = await matchMedications(['unknownium'], rx);
    expect(m).toMatchObject({ status: 'not_recognized', via: null, classes: [] });
  });
});

describe('stack_analyze with medications and conditions', () => {
  it('reports in-stack interactions first, with timing, sources and gaps', async () => {
    const res = await post('/v1/stack/analyze', {
      age: 58,
      sex: 'male',
      medications: ['warfarin', 'Synthroid 50 mcg', 'zzzdrug'],
      products: multi([
        { name: 'vitamin K', amount: 120, unit: 'mcg' },
        { name: 'calcium', amount: 500, unit: 'mg' },
      ]),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const ix = body.interactions;
    expect(ix.scope).toMatch(/not exhaustive/);
    expect(ix.medications.map((m: { status: string }) => m.status)).toEqual(['matched', 'matched', 'not_recognized']);
    expect(ix.findings[0]).toMatchObject({ trigger: 'warfarin', nutrient_ids: ['vitamin-k'], in_stack: true, kind: 'supplement_changes_drug', product_refs: ['custom:1'] });
    const thyroid = ix.findings.find((f: { trigger: string; nutrient_ids: string[] }) => f.trigger === 'Synthroid 50 mcg' && f.nutrient_ids.includes('calcium'));
    expect(thyroid.timing).toMatch(/4 hours/);
    // in_stack findings come before the rest.
    const flags = ix.findings.map((f: { in_stack: boolean }) => f.in_stack);
    expect(flags).toEqual([...flags].sort((x: boolean, y: boolean) => Number(y) - Number(x)));

    const codes = body.data_gaps.map((g: { code: string }) => g.code);
    expect(codes).toContain('INTERACTIONS_PARTIAL');
    expect(codes).toContain('MEDICATION_NOT_RECOGNIZED');
    expect(codes).not.toContain('INTERACTIONS_NOT_ASSESSED');
    expect(body.summary.data_gaps).toBe(body.data_gaps.length);
    expect(body.sources.map((s: { url: string }) => s.url)).toContain('https://ods.od.nih.gov/factsheets/VitaminK-HealthProfessional/');

    expect(body.agent_summary).toMatch(/Warfarin with Vitamin K in this stack/);
    expect(body.agent_summary).toMatch(/Not recognized, so not checked: "zzzdrug"/);
    expect(body.agent_summary).toMatch(/pharmacist/);
    expect(body.agent_summary).not.toMatch(/\bsafe\b|no risk/i);
  });

  it('says when the listed medications have no NIH-listed interaction with the stack', async () => {
    const res = await post('/v1/stack/analyze', { age: 40, sex: 'female', medications: ['warfarin'], products: multi([{ name: 'vitamin C', amount: 250, unit: 'mg' }]) });
    const body = res.json();
    expect(body.interactions.findings.every((f: { in_stack: boolean }) => !f.in_stack)).toBe(true);
    expect(body.agent_summary).toMatch(/list no interaction .* not exhaustive/);
  });

  it('flags condition doses only at or above the NIH threshold', async () => {
    const run = async (mcg: number) =>
      (await post('/v1/stack/analyze', { age: 60, sex: 'male', conditions: ['smoker'], products: multi([{ name: 'beta-carotene', amount: mcg, unit: 'mcg' }]) })).json();
    const high = await run(25000);
    expect(high.interactions.findings).toHaveLength(1);
    expect(high.interactions.findings[0]).toMatchObject({ type: 'condition', trigger: 'smoker', in_stack: true });
    expect(high.agent_summary).toMatch(/Beta-Carotene in this stack \(current or former smoker/);
    const low = await run(3000);
    expect(low.interactions.findings).toHaveLength(0);
    // Conditions alone do not replace the medication gap.
    expect(low.data_gaps.map((g: { code: string }) => g.code)).toContain('INTERACTIONS_NOT_ASSESSED');
  });

  it('counts vitamin A declared as beta-carotene toward the smoker check', async () => {
    const res = await post('/v1/stack/analyze', {
      age: 60,
      sex: 'male',
      conditions: ['smoker'],
      products: [{ name: 'A', ingredients: [{ name: 'vitamin A', amount: 12000, unit: 'mcg RAE', form: 'beta-carotene' }] }],
    });
    const f = res.json().interactions.findings;
    expect(f).toHaveLength(1);
    expect(f[0].nutrient_ids).toEqual(['beta-carotene']);
  });

  it('gives a compact form with detail "summary"', async () => {
    const res = await post('/v1/stack/analyze', { age: 58, sex: 'male', detail: 'summary', medications: ['warfarin'], products: multi([{ name: 'vitamin K', amount: 120, unit: 'mcg' }]) });
    const ix = res.json().interactions;
    expect(ix.medications).toEqual([{ input: 'warfarin', status: 'matched', matched_name: 'warfarin' }]);
    expect(ix.findings[0]).not.toHaveProperty('source');
    expect(typeof ix.not_in_stack).toBe('number');
  });

  it('leaves the response unchanged when neither medications nor conditions are given', async () => {
    const res = await post('/v1/stack/analyze', { age: 40, sex: 'female', products: multi([{ name: 'vitamin K', amount: 120, unit: 'mcg' }]) });
    const body = res.json();
    expect(body).not.toHaveProperty('interactions');
    expect(body.summary).not.toHaveProperty('interaction_findings');
  });

  it('rejects unknown conditions and empty medication names', async () => {
    const bad = await post('/v1/stack/analyze', { age: 40, sex: 'female', conditions: ['diabetes'], products: multi([{ name: 'zinc', amount: 5, unit: 'mg' }]) });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.field).toBe('conditions.0');
    const empty = await post('/v1/stack/analyze', { age: 40, sex: 'female', medications: [' '], products: multi([{ name: 'zinc', amount: 5, unit: 'mg' }]) });
    expect(empty.statusCode).toBe(400);
  });
});

describe('POST /v1/interactions/check', () => {
  it('lists NIH interactions for a medication, filtered by nutrient', async () => {
    const res = await post('/v1/interactions/check', { medications: ['Coumadin'], nutrients: ['vitamin k'] });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.findings).toHaveLength(1);
    expect(body.findings[0]).toMatchObject({ nutrient_ids: ['vitamin-k'], in_stack: false });
    expect(body.sources).toHaveLength(1);
  });

  it('lists condition checks with their dose thresholds', async () => {
    const body = (await post('/v1/interactions/check', { conditions: ['kidney_disease'] })).json();
    expect(body.findings.length).toBeGreaterThan(0);
    expect(body.findings.every((f: { type: string }) => f.type === 'condition')).toBe(true);
    expect(body.findings[0].summary).toMatch(/Checked from \d+/);
  });

  it('requires medications or conditions, and known nutrients', async () => {
    expect((await post('/v1/interactions/check', {})).statusCode).toBe(400);
    const unknown = await post('/v1/interactions/check', { medications: ['warfarin'], nutrients: ['unobtainium'] });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.field).toBe('nutrients.0');
  });

  it('reports unrecognized medications as a data gap', async () => {
    const body = (await post('/v1/interactions/check', { medications: ['zzzdrug'] })).json();
    expect(body.summary).toEqual({ medications: 1, medications_recognized: 0, findings: 0 });
    expect(body.data_gaps[0].code).toBe('MEDICATION_NOT_RECOGNIZED');
  });

  it('is reachable through /v1/tool and MCP', async () => {
    const viaTool = await post('/v1/tool', { tool: 'interactions_check', arguments: { medications: ['levothyroxine'] } });
    expect(viaTool.statusCode).toBe(200);
    expect(viaTool.json().findings.length).toBeGreaterThan(0);
    const viaMcp = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'interactions_check', arguments: { medications: ['levothyroxine'] } } });
    expect(viaMcp.json().result.isError).toBe(false);
  });

  it('uses the injected RxNorm client', async () => {
    const fake: FetchLike = async (url) =>
      new Response(
        JSON.stringify(
          url.includes('approximateTerm')
            ? { approximateGroup: { candidate: [{ rxcui: '42' }] } }
            : { relatedGroup: { conceptGroup: [{ conceptProperties: [{ name: 'omeprazole' }] }] } },
        ),
      );
    const rxApp = buildApp({ dsld: fixtureClient(), rxnorm: new RxNormClient(fake, 'https://rx.test') });
    const body = (await rxApp.inject({ method: 'POST', url: '/v1/interactions/check', payload: { medications: ['Losec MUPS'] } })).json();
    await rxApp.close();
    expect(body.medications[0]).toMatchObject({ status: 'matched', via: 'rxnorm', matched_name: 'omeprazole' });
  });
});

it('exposes every condition id in the schema enum', () => {
  expect(CONDITION_IDS).toEqual(Object.keys(data.conditions));
});
