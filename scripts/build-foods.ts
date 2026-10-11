/**
 * Builds data/foods.json from USDA National Nutrient Database for Standard
 * Reference, Release 28 (SR28, the data FoodData Central serves as "SR Legacy"),
 * as shipped in the npm package fda-nutrient-database@1.0.2 (ABBREV.txt and
 * FOOD_DES.txt, unchanged USDA files; checksums verified below).
 *
 *   npx tsx scripts/build-foods.ts           # write data/foods.json
 *   npx tsx scripts/build-foods.ts --check   # fail if the committed file is stale
 *
 * Values are per 100 g of edible portion, in each nutrient's canonical unit.
 * A blank SR28 cell means "not analyzed" and stays null, never 0.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const PKG = path.dirname(require.resolve('fda-nutrient-database/package.json'));
const OUT = 'data/foods.json';
const SHA256: Record<string, string> = {
  'ABBREV.txt': '4c42235a001efd5e94ce38001682138056aa1b755427b8a8d315c2b02cd2b85b',
  'FOOD_DES.txt': 'bb2047218cdad1d830da69e760386409fde3b7afabceae604c5479f280d4fa2e',
};

/** SR28 ABBREV.txt columns (sr28_doc.pdf, Abbreviated file format). */
const COLS =
  'ndb desc water kcal protein lipid ash carb fiber sugar calcium iron magnesium phosphorus potassium sodium zinc copper manganese selenium vitamin_c thiamin riboflavin niacin pantothenic vitamin_b6 folate_total folic_acid food_folate folate_dfe choline vitamin_b12 vitamin_a_iu vitamin_a_rae retinol alpha_carotene beta_carotene beta_cryptoxanthin lycopene lutein_zeaxanthin vitamin_e vitamin_d_mcg vitamin_d_iu vitamin_k fa_sat fa_mono fa_poly cholesterol gm1 gm1_desc gm2 gm2_desc refuse'.split(
    ' ',
  );

/** Service nutrient id -> SR28 column, a unit factor to the canonical unit, and the column that counts toward the UL. */
/**
 * toward: the column counting toward the UL; 'none' when food never counts (magnesium);
 * null when the countable part (fortificants) can't be separated in SR28, so the UL check is not made.
 */
export const NUTRIENTS: { id: string; col: string; factor: number; toward: string | 'none' | null }[] = [
  { id: 'calcium', col: 'calcium', factor: 1, toward: 'calcium' },
  { id: 'iron', col: 'iron', factor: 1, toward: 'iron' },
  { id: 'magnesium', col: 'magnesium', factor: 1, toward: 'none' }, // UL is for supplements only
  { id: 'phosphorus', col: 'phosphorus', factor: 1, toward: 'phosphorus' },
  { id: 'potassium', col: 'potassium', factor: 1, toward: 'potassium' },
  { id: 'sodium', col: 'sodium', factor: 1, toward: 'sodium' },
  { id: 'zinc', col: 'zinc', factor: 1, toward: 'zinc' },
  { id: 'copper', col: 'copper', factor: 1000, toward: 'copper' }, // mg -> mcg
  { id: 'manganese', col: 'manganese', factor: 1, toward: 'manganese' },
  { id: 'selenium', col: 'selenium', factor: 1, toward: 'selenium' },
  { id: 'vitamin-c', col: 'vitamin_c', factor: 1, toward: 'vitamin_c' },
  { id: 'thiamin', col: 'thiamin', factor: 1, toward: 'thiamin' },
  { id: 'riboflavin', col: 'riboflavin', factor: 1, toward: 'riboflavin' },
  { id: 'niacin', col: 'niacin', factor: 1, toward: null }, // UL covers supplements and fortificants, not separable here
  { id: 'pantothenic-acid', col: 'pantothenic', factor: 1, toward: 'pantothenic' },
  { id: 'vitamin-b6', col: 'vitamin_b6', factor: 1, toward: 'vitamin_b6' },
  { id: 'folate', col: 'folate_dfe', factor: 1, toward: 'folic_acid' }, // UL counts folic acid from fortified food
  { id: 'choline', col: 'choline', factor: 1, toward: 'choline' },
  { id: 'vitamin-b12', col: 'vitamin_b12', factor: 1, toward: 'vitamin_b12' },
  { id: 'vitamin-a', col: 'vitamin_a_rae', factor: 1, toward: 'retinol' }, // UL counts preformed vitamin A only
  { id: 'beta-carotene', col: 'beta_carotene', factor: 1, toward: 'beta_carotene' },
  { id: 'vitamin-e', col: 'vitamin_e', factor: 1, toward: null }, // UL covers supplemental and added alpha-tocopherol only
  { id: 'vitamin-d', col: 'vitamin_d_mcg', factor: 1, toward: 'vitamin_d_mcg' },
  { id: 'vitamin-k', col: 'vitamin_k', factor: 1, toward: 'vitamin_k' },
];

/**
 * SR28 values that are implausible by orders of magnitude (checked against the
 * same food's domestic or sibling entries) and are excluded rather than
 * corrected. The food still counts for its other nutrients; the response
 * reports the exclusion.
 */
const SUSPECT: Record<string, { nutrient: string; why: string }[]> = {
  '23424': [{ nutrient: 'manganese', why: 'SR28 lists 328 mg/100 g; domestic beef liver (13325) has 0.31 mg' }],
  '23425': [{ nutrient: 'manganese', why: 'SR28 lists 299 mg/100 g; domestic beef liver (13325) has 0.31 mg' }],
  '14055': [{ nutrient: 'manganese', why: 'SR28 lists 269 mg/100 g for a shake mix, far above any whole food' }],
};

function sha(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

const unquote = (s: string) => s.replace(/^~|~$/g, '');
const num = (s: string | undefined): number | null => (s === undefined || s.trim() === '' ? null : Number(s));
const r4 = (v: number) => Math.round(v * 10000) / 10000;

export function build(): string {
  for (const [f, want] of Object.entries(SHA256)) {
    const got = sha(path.join(PKG, 'data', f));
    if (got !== want) throw new Error(`${f}: checksum ${got} does not match the reviewed USDA file`);
  }
  const lines = (f: string) => readFileSync(path.join(PKG, 'data', f), 'latin1').split(/\r?\n/).filter(Boolean).map((l) => l.split('^'));
  const longDesc = new Map(lines('FOOD_DES.txt').map((r) => [unquote(r[0]!), unquote(r[2]!)]));

  const foods = lines('ABBREV.txt').map((r) => {
    if (r.length !== COLS.length) throw new Error(`row ${r[0]} has ${r.length} fields`);
    const row = Object.fromEntries(COLS.map((c, i) => [c, r[i]!]));
    const ndb = unquote(row.ndb!);
    const suspect = new Set((SUSPECT[ndb] ?? []).map((s) => s.nutrient));
    const values = NUTRIENTS.map((n) => {
      if (suspect.has(n.id)) return null;
      const v = num(row[n.col]);
      return v === null ? null : r4(v * n.factor);
    });
    const toward = NUTRIENTS.map((n) => {
      if (suspect.has(n.id)) return null;
      if (n.toward === 'none') return 0;
      if (n.toward === null) return null;
      const v = num(row[n.toward]);
      return v === null ? null : r4(v * n.factor);
    });
    const portions: [number, string][] = [];
    for (const [g, d] of [
      [row.gm1, row.gm1_desc],
      [row.gm2, row.gm2_desc],
    ] as const) {
      const grams = num(g);
      if (grams && grams > 0 && d && unquote(d)) portions.push([grams, unquote(d)]);
    }
    return [ndb, longDesc.get(ndb) ?? unquote(row.desc!), values, toward, portions];
  });

  const out = {
    _doc: 'USDA SR28 foods, per 100 g edible portion. Each food: [ndb_number, description, values in nutrient order (null = not analyzed), amount counting toward the UL in nutrient order (0 = food does not count toward that UL; null = not separable or not analyzed), household portions [grams, description]]. Built by scripts/build-foods.ts; do not edit.',
    source: {
      name: 'USDA ARS, National Nutrient Database for Standard Reference, Release 28 (SR28; FoodData Central "SR Legacy")',
      url: 'https://fdc.nal.usda.gov/',
      retrieved: '2026-10-11',
    },
    nutrients: NUTRIENTS.map((n) => n.id),
    suspect: SUSPECT,
    foods,
  };
  return `${JSON.stringify(out)}\n`;
}

const isMain = process.argv[1]?.endsWith('build-foods.ts');
if (isMain) {
  const text = build();
  if (process.argv.includes('--check')) {
    if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== text) {
      console.error(`${OUT} is stale; run npm run build:foods`);
      process.exit(1);
    }
    console.log(`${OUT} is up to date.`);
  } else {
    writeFileSync(OUT, text);
    console.log(`Wrote ${OUT}`);
  }
}
