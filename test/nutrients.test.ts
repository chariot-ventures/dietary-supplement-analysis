import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildNutrients, validateNutrients } from '../scripts/build-nutrients.js';
import { nutrientIndex } from '../src/lib/nutrients.js';
import type { SexTable } from '../src/lib/types.js';
import { ROOT } from './helpers.js';

const manual: unknown = JSON.parse(readFileSync(path.join(ROOT, 'data/source/manual.json'), 'utf8'));

const V1_DRI_NUTRIENTS = [
  'vitamin-a', 'vitamin-c', 'vitamin-d', 'vitamin-e', 'vitamin-k', 'thiamin', 'riboflavin', 'niacin', 'vitamin-b6', 'folate',
  'vitamin-b12', 'biotin', 'pantothenic-acid', 'choline', 'calcium', 'chromium', 'copper', 'iodine', 'iron', 'magnesium',
  'manganese', 'molybdenum', 'phosphorus', 'potassium', 'selenium', 'zinc',
];

describe('data/nutrients.json', () => {
  it('is up to date with data/source', () => {
    const built = buildNutrients(manual);
    const committed: unknown = JSON.parse(readFileSync(path.join(ROOT, 'data/nutrients.json'), 'utf8'));
    expect(committed).toEqual(built);
  });

  it('passes validation', () => {
    expect(validateNutrients(nutrientIndex.all)).toEqual([]);
  });

  it('covers all 26 v1 DRI nutrients, each with DRIs and an https source', () => {
    for (const id of V1_DRI_NUTRIENTS) {
      const n = nutrientIndex.get(id);
      expect(n, id).toBeDefined();
      expect(n!.dri, id).not.toBeNull();
      expect(n!.source_url, id).toMatch(/^https:\/\//);
    }
  });

  it('every DRI table covers ages 1 and up for both sexes without gaps', () => {
    for (const n of nutrientIndex.all) {
      if (!n.dri) continue;
      for (const [type, table] of Object.entries(n.dri) as [string, SexTable | null][]) {
        if (!table) continue;
        for (const sex of ['male', 'female'] as const) {
          for (const age of [1, 4, 9, 14, 19, 31, 51, 71, 100]) {
            const hit = table[sex].find((r) => (r.lower ?? -Infinity) <= age && age <= (r.upper ?? Infinity));
            expect(hit, `${n.id}.${type}.${sex} @${age}`).toBeDefined();
          }
        }
      }
    }
  });
});

describe('build validation', () => {
  const base = JSON.parse(JSON.stringify(manual)) as { nutrients: Record<string, unknown>[] };

  it('rejects an unknown canonical unit', () => {
    const bad = structuredClone(base);
    bad.nutrients[0]!.canonical_unit = 'cups';
    expect(() => buildNutrients(bad)).toThrow(/canonical_unit/);
  });

  it('rejects a synonym shared by two nutrients', () => {
    const bad = structuredClone(base);
    (bad.nutrients[1]!.synonyms as string[]).push('vitamin a');
    expect(() => buildNutrients(bad)).toThrow(/synonym/);
  });

  it('rejects the wrong number of band values', () => {
    const bad = structuredClone(base);
    (bad.nutrients[0]!.dri_bands as { rda: { male: number[] } }).rda.male.pop();
    expect(() => buildNutrients(bad)).toThrow(/band values/);
  });

  it('converts a SuppleTracker export and keeps manual entries authoritative', () => {
    const exportRows = [
      {
        id: 1,
        name: 'Vanadium',
        akas: ['vanadyl sulfate'],
        ods_factsheets: ['https://ods.od.nih.gov/factsheets/Vanadium-HealthProfessional/'],
        dri_data: { unit: 'mg', type: { ul: { male: { years: [{ lower: 19, upper: null, amount: 20 }] }, female: { years: [{ lower: 19, upper: null, amount: 20 }] } } } },
      },
      { id: 2, name: 'Vitamin D', akas: [], ods_factsheets: [], dri_data: null },
    ];
    const built = buildNutrients(manual, exportRows);
    const vanadium = built.nutrients.find((n) => n.id === 'vanadium')!;
    expect(vanadium.dri?.ul?.male).toEqual([{ lower: 19, upper: null, amount: 20 }]);
    expect(vanadium.source_url).toBe('https://ods.od.nih.gov/factsheets/Vanadium-HealthProfessional/');
    expect(built.nutrients.find((n) => n.id === 'vitamin-d')!.dri).not.toBeNull();
  });

  it('rejects export rows with overlapping ranges or no source', () => {
    const overlapping = [
      {
        name: 'Vanadium',
        ods_factsheets: 'https://ods.od.nih.gov/factsheets/Vanadium-HealthProfessional/',
        dri_data: { unit: 'mg', type: { ul: { male: { years: [{ lower: 14, upper: 30, amount: 17 }, { lower: 19, upper: null, amount: 20 }] }, female: { years: [] } } } },
      },
    ];
    expect(() => buildNutrients(manual, overlapping)).toThrow(/overlap/);
    expect(() => buildNutrients(manual, [{ name: 'Vanadium', dri_data: { unit: 'mg', type: { ul: { male: { years: [{ lower: 1, upper: null, amount: 1 }] } } } } }])).toThrow(/https/);
  });
});
