/**
 * Build data/nutrients.json from data/source/manual.json and, when present,
 * the SuppleTracker Supabase export (data/source/global_compounds.export.json).
 *
 *   npx tsx scripts/build-nutrients.ts           # write data/nutrients.json
 *   npx tsx scripts/build-nutrients.ts --check   # fail if the committed file is stale or invalid
 *
 * Manual entries win over export entries with the same id. The build fails if
 * any entry is invalid: unknown unit, DRI without a source URL, overlapping age
 * ranges, a synonym claimed by two nutrients, and so on.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';
import { normalizeName } from '../src/lib/text.js';
import { parseUnit } from '../src/lib/units.js';
import type { AgeRange, DriTables, DriType, LifeStageTables, Nutrient, NutrientsFile, Sex, SexTable, StageTable } from '../src/lib/types.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANUAL = path.join(ROOT, 'data/source/manual.json');
const EXPORT = path.join(ROOT, 'data/source/global_compounds.export.json');
const OUT = path.join(ROOT, 'data/nutrients.json');

const DRI_TYPES: DriType[] = ['rda', 'ear', 'ai', 'ul'];
const SEXES: Sex[] = ['male', 'female'];

// ---------- source schemas ----------

const bandValues = z.array(z.number().positive().nullable());
const bandTable = z
  .object({ male: bandValues.optional(), female: bandValues.optional(), both: bandValues.optional() })
  .strict()
  .nullable();

const stageValues = (n: number) => z.array(z.number().positive().nullable()).length(n);
const stageTable = (n: number) =>
  z.object({ rda: stageValues(n).optional(), ear: stageValues(n).optional(), ai: stageValues(n).optional(), ul: stageValues(n).optional() }).strict();
const manualLifeStages = z
  .object({ pregnancy: stageTable(3).optional(), lactation: stageTable(3).optional(), infants: stageTable(2).optional() })
  .strict();

const manualNutrient = z
  .object({
    id: z.string(),
    name: z.string(),
    canonical_unit: z.string(),
    synonyms: z.array(z.string()),
    dsld_ingredient_groups: z.array(z.string()).default([]),
    unii_codes: z.array(z.string()).default([]),
    forms: z.array(z.object({ name: z.string(), kind: z.string() }).strict()).default([]),
    unit_conversions: z
      .array(
        z
          .object({
            from: z.string(),
            factor: z.number().positive(),
            applies_to_forms: z.array(z.string()).min(1),
            note: z.string().optional(),
          })
          .strict(),
      )
      .default([]),
    plain_mass_is_canonical: z.boolean().default(false),
    label_dv: z.object({ amount: z.number().positive(), unit: z.string() }).strict().nullable().default(null),
    label_dv_legacy: z.object({ amount: z.number().positive(), unit: z.string() }).strict().nullable().default(null),
    name_overrides_groups: z.array(z.string()).default([]),
    dri_bands: z.object({ rda: bandTable, ear: bandTable, ai: bandTable, ul: bandTable }).strict().nullable(),
    life_stages: manualLifeStages.optional(),
    ul_unit: z.string().nullable(),
    ul_component: z.enum(['all', 'preformed', 'folic_acid']),
    ul_scope: z.string(),
    ul_note: z.string().nullable(),
    ul_basis: z.string().nullable().default(null),
    factsheet_url: z.string(),
    source_url: z.string().optional(),
  })
  .strict();

const manualFile = z
  .object({
    _doc: z.string().optional(),
    dri_reviewed: z.string(),
    label_dv_source: z.string().optional(),
    label_dv_legacy_source: z.string().optional(),
    ul_basis_source: z.string().optional(),
    age_bands: z.array(z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative().nullable()])),
    nutrients: z.array(manualNutrient),
  })
  .strict();

type ManualFile = z.infer<typeof manualFile>;
type ManualNutrient = z.infer<typeof manualNutrient>;

// SuppleTracker `global_compounds` row (see PLAN.md section 2a).
const exportRange = z.object({ lower: z.number().nullable(), upper: z.number().nullable(), amount: z.number().nullable() });
const exportSex = z.object({ years: z.array(exportRange) }).partial();
const exportRow = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  name: z.string(),
  akas: z.union([z.array(z.string()), z.string(), z.null()]).optional(),
  ods_factsheets: z.unknown().optional(),
  dri_data: z
    .object({
      unit: z.string().optional(),
      type: z.record(z.string(), z.object({ male: exportSex.optional(), female: exportSex.optional() }).nullable()).optional(),
    })
    .nullable()
    .optional(),
});

// ---------- built-file schema (also used by tests) ----------

const ageRange = z.object({ lower: z.number().int().nonnegative().nullable(), upper: z.number().int().nonnegative().nullable(), amount: z.number().positive() }).strict();
const sexTable = z.object({ male: z.array(ageRange), female: z.array(ageRange) }).strict().nullable();
const stageRanges = z.array(ageRange).nullable();
const builtStage = z.object({ rda: stageRanges, ear: stageRanges, ai: stageRanges, ul: stageRanges }).strict().nullable();
const httpsUrl = z.string().regex(/^https:\/\/\S+$/, 'must be an https URL');

export const builtNutrientSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string().min(1),
    canonical_unit: z.string(),
    synonyms: z.array(z.string().min(1)).min(1),
    dsld_ingredient_groups: z.array(z.string()),
    unii_codes: z.array(z.string().regex(/^[A-Z0-9]{10}$/)),
    forms: z.array(z.object({ name: z.string(), kind: z.string() }).strict()),
    unit_conversions: z.array(
      z.object({ from: z.string(), factor: z.number().positive(), applies_to_forms: z.array(z.string()).min(1), note: z.string().optional() }).strict(),
    ),
    plain_mass_is_canonical: z.boolean(),
    dri: z.object({ rda: sexTable, ear: sexTable, ai: sexTable, ul: sexTable }).strict().nullable(),
    life_stages: z.object({ pregnancy: builtStage, lactation: builtStage, infants: builtStage }).strict().nullable(),
    label_dv: z.object({ amount: z.number().positive(), unit: z.string() }).strict().nullable(),
    label_dv_legacy: z.object({ amount: z.number().positive(), unit: z.string() }).strict().nullable(),
    name_overrides_groups: z.array(z.string()),
    ul_unit: z.string().nullable(),
    ul_component: z.enum(['all', 'preformed', 'folic_acid']),
    ul_scope: z.string(),
    ul_note: z.string().nullable(),
    ul_basis: z.string().min(1).nullable(),
    factsheet_url: httpsUrl,
    source_url: httpsUrl,
  })
  .strict();

// ---------- conversion ----------

function slugify(name: string): string {
  return normalizeName(name).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function expandBands(table: z.infer<typeof bandTable>, bands: ManualFile['age_bands'], where: string): SexTable | null {
  if (table == null) return null;
  const out: SexTable = { male: [], female: [] };
  for (const sex of SEXES) {
    const values = table[sex] ?? table.both;
    if (!values) throw new Error(`${where}: missing values for ${sex}`);
    if (values.length !== bands.length) throw new Error(`${where}.${sex}: expected ${bands.length} band values, got ${values.length}`);
    values.forEach((amount, i) => {
      if (amount == null) return;
      const [lower, upper] = bands[i]!;
      out[sex].push({ lower, upper, amount });
    });
  }
  return out;
}

const STAGE_YEARS: [number, number][] = [
  [14, 18],
  [19, 30],
  [31, 50],
];
/** Infant ranges are in months. */
const INFANT_MONTHS: [number, number][] = [
  [0, 5],
  [6, 11],
];

function stageRangesFrom(values: (number | null)[] | undefined, spans: [number, number][]): AgeRange[] | null {
  if (!values) return null;
  const out = values.flatMap((amount, i) => (amount == null ? [] : [{ lower: spans[i]![0], upper: spans[i]![1], amount }]));
  return out.length ? out : null;
}

/** Female UL for the age ranges pregnancy and lactation use (the FNB sets them equal unless stated). */
function femaleUlAt(dri: DriTables | null, years: [number, number]): number | null {
  return dri?.ul?.female.find((r) => (r.lower ?? 0) <= years[0] && (r.upper ?? Infinity) >= years[1])?.amount ?? null;
}

function buildLifeStages(n: ManualNutrient, dri: DriTables | null): LifeStageTables | null {
  if (!dri) return null;
  const ls = n.life_stages ?? {};
  const stage = (name: 'pregnancy' | 'lactation'): StageTable | null => {
    const src = ls[name] ?? {};
    const t: StageTable = {
      rda: stageRangesFrom(src.rda, STAGE_YEARS),
      ear: stageRangesFrom(src.ear, STAGE_YEARS),
      ai: stageRangesFrom(src.ai, STAGE_YEARS),
      ul: stageRangesFrom(src.ul ?? STAGE_YEARS.map((y) => femaleUlAt(dri, y)), STAGE_YEARS),
    };
    return t.rda || t.ear || t.ai || t.ul ? t : null;
  };
  const inf = ls.infants;
  const infants: StageTable | null = inf
    ? { rda: stageRangesFrom(inf.rda, INFANT_MONTHS), ear: stageRangesFrom(inf.ear, INFANT_MONTHS), ai: stageRangesFrom(inf.ai, INFANT_MONTHS), ul: stageRangesFrom(inf.ul, INFANT_MONTHS) }
    : null;
  return { pregnancy: stage('pregnancy'), lactation: stage('lactation'), infants: infants && (infants.rda || infants.ai || infants.ul || infants.ear) ? infants : null };
}

function fromManual(n: ManualNutrient, bands: ManualFile['age_bands']): Nutrient {
  let dri: DriTables | null = null;
  if (n.dri_bands) {
    dri = { rda: null, ear: null, ai: null, ul: null };
    for (const t of DRI_TYPES) dri[t] = expandBands(n.dri_bands[t], bands, `${n.id}.dri_bands.${t}`);
  }
  const life_stages = buildLifeStages(n, dri);
  return {
    id: n.id,
    name: n.name,
    canonical_unit: n.canonical_unit,
    synonyms: n.synonyms,
    dsld_ingredient_groups: n.dsld_ingredient_groups,
    unii_codes: n.unii_codes,
    forms: n.forms,
    unit_conversions: n.unit_conversions,
    plain_mass_is_canonical: n.plain_mass_is_canonical,
    dri,
    life_stages,
    label_dv: n.label_dv,
    label_dv_legacy: n.label_dv_legacy,
    name_overrides_groups: n.name_overrides_groups,
    ul_unit: n.ul_unit,
    ul_component: n.ul_component,
    ul_scope: n.ul_scope,
    ul_note: n.ul_note,
    ul_basis: n.ul_basis,
    factsheet_url: n.factsheet_url,
    source_url: n.source_url ?? n.factsheet_url,
  };
}

function firstUrl(value: unknown): string | null {
  if (typeof value === 'string') return value.match(/https:\/\/\S+/)?.[0] ?? null;
  if (Array.isArray(value)) {
    for (const v of value) {
      const u = firstUrl(v);
      if (u) return u;
    }
    return null;
  }
  if (value && typeof value === 'object') return firstUrl(Object.values(value));
  return null;
}

function fromExport(row: z.infer<typeof exportRow>): Nutrient {
  const akas = Array.isArray(row.akas) ? row.akas : typeof row.akas === 'string' ? row.akas.split(',') : [];
  const factsheet = firstUrl(row.ods_factsheets);
  let dri: DriTables | null = null;
  if (row.dri_data?.type) {
    dri = { rda: null, ear: null, ai: null, ul: null };
    for (const t of DRI_TYPES) {
      const src = row.dri_data.type[t];
      if (!src) continue;
      const table: SexTable = { male: [], female: [] };
      for (const sex of SEXES) {
        for (const r of src[sex]?.years ?? []) {
          if (r.amount == null) continue;
          table[sex].push({ lower: r.lower, upper: r.upper, amount: r.amount } satisfies AgeRange);
        }
      }
      dri[t] = table;
    }
  }
  const unit = row.dri_data?.unit ?? 'mg';
  return {
    id: slugify(row.name),
    name: row.name,
    canonical_unit: unit,
    synonyms: [...new Set([row.name, ...akas].map((s) => s.trim()).filter(Boolean))],
    dsld_ingredient_groups: [row.name],
    unii_codes: [],
    forms: [],
    unit_conversions: [],
    plain_mass_is_canonical: false,
    dri,
    life_stages: null,
    label_dv: null,
    label_dv_legacy: null,
    name_overrides_groups: [],
    ul_unit: dri?.ul ? unit : null,
    ul_component: 'all',
    ul_scope: dri?.ul ? 'total_intake' : 'not_established',
    ul_note: null,
    ul_basis: null,
    factsheet_url: factsheet ?? '',
    source_url: factsheet ?? '',
  };
}

// ---------- validation ----------

function rangesOverlap(a: AgeRange, b: AgeRange): boolean {
  const aLo = a.lower ?? -Infinity;
  const aHi = a.upper ?? Infinity;
  const bLo = b.lower ?? -Infinity;
  const bHi = b.upper ?? Infinity;
  return aLo <= bHi && bLo <= aHi;
}

export function validateNutrients(list: Nutrient[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const synonymOwner = new Map<string, string>();

  for (const n of list) {
    const parsed = builtNutrientSchema.safeParse(n);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) errors.push(`${n.id}.${issue.path.join('.')}: ${issue.message}`);
      continue;
    }
    if (ids.has(n.id)) errors.push(`${n.id}: duplicate id`);
    ids.add(n.id);

    const canonical = parseUnit(n.canonical_unit);
    if (canonical.kind !== 'mass') errors.push(`${n.id}: canonical_unit "${n.canonical_unit}" is not a known mass unit`);
    if (n.label_dv) {
      const dv = parseUnit(n.label_dv.unit);
      if (dv.kind !== 'mass' || canonical.kind !== 'mass' || dv.basis !== canonical.basis) errors.push(`${n.id}: label_dv unit "${n.label_dv.unit}" must be a mass unit in the canonical basis`);
    }
    if (n.label_dv_legacy) {
      const dv = parseUnit(n.label_dv_legacy.unit);
      if (dv.kind !== 'mass' || canonical.kind !== 'mass' || dv.basis !== canonical.basis) errors.push(`${n.id}: label_dv_legacy unit "${n.label_dv_legacy.unit}" must be a mass unit in the canonical basis`);
    }
    if (n.ul_unit !== null && parseUnit(n.ul_unit).kind !== 'mass') errors.push(`${n.id}: ul_unit "${n.ul_unit}" is not a known mass unit`);
    for (const c of n.unit_conversions) {
      if (parseUnit(c.from).kind === 'unknown') errors.push(`${n.id}: unit_conversions.from "${c.from}" is not a known unit`);
      const kinds = new Set(n.forms.map((f) => f.kind));
      for (const k of c.applies_to_forms) if (k !== '*' && !kinds.has(k)) errors.push(`${n.id}: conversion applies to unknown form kind "${k}"`);
    }

    for (const s of n.synonyms) {
      const key = normalizeName(s);
      const owner = synonymOwner.get(key);
      if (owner && owner !== n.id) errors.push(`${n.id}: synonym "${s}" is also a synonym of ${owner}`);
      synonymOwner.set(key, n.id);
    }

    if (n.dri) {
      if (!n.source_url) errors.push(`${n.id}: DRI values need a source_url`);
      if (n.dri.ul && n.ul_unit === null) errors.push(`${n.id}: has a UL but no ul_unit`);
      if (n.dri.ul && !n.ul_basis && n.label_dv !== null) errors.push(`${n.id}: has a UL but no ul_basis (the adverse effect the UL protects against)`);
      if (!n.dri.rda && !n.dri.ai && !n.dri.ear && !n.dri.ul) errors.push(`${n.id}: dri object has no tables; use dri: null`);
      for (const t of DRI_TYPES) {
        const table = n.dri[t];
        if (!table) continue;
        for (const sex of SEXES) {
          const rows = table[sex];
          rows.forEach((r, i) => {
            if (r.lower !== null && r.upper !== null && r.lower > r.upper) errors.push(`${n.id}.${t}.${sex}[${i}]: lower > upper`);
            for (let j = i + 1; j < rows.length; j++) {
              if (rangesOverlap(r, rows[j]!)) errors.push(`${n.id}.${t}.${sex}: ranges ${i} and ${j} overlap`);
            }
          });
        }
      }
    }
  }
  return errors;
}

// ---------- main ----------

export function buildNutrients(manualRaw: unknown, exportRaw?: unknown): NutrientsFile {
  const manual = manualFile.parse(manualRaw);
  const byId = new Map<string, Nutrient>();

  if (exportRaw !== undefined) {
    for (const row of z.array(exportRow).parse(exportRaw)) {
      const n = fromExport(row);
      byId.set(n.id, n);
    }
  }
  for (const m of manual.nutrients) byId.set(m.id, fromManual(m, manual.age_bands));

  const nutrients = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  const errors = validateNutrients(nutrients);
  if (errors.length) throw new Error(`nutrients.json validation failed:\n  - ${errors.join('\n  - ')}`);

  return {
    _generated: 'Built by scripts/build-nutrients.ts from data/source/. Do not edit by hand.',
    dri_reviewed: manual.dri_reviewed,
    nutrients,
  };
}

function main(): void {
  const check = process.argv.includes('--check');
  const manualRaw: unknown = JSON.parse(readFileSync(MANUAL, 'utf8'));
  const exportRaw: unknown = existsSync(EXPORT) ? JSON.parse(readFileSync(EXPORT, 'utf8')) : undefined;
  const built = buildNutrients(manualRaw, exportRaw);
  const text = `${JSON.stringify(built, null, 2)}\n`;

  if (check) {
    const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
    if (current !== text) {
      console.error('data/nutrients.json is out of date. Run: npm run build:nutrients');
      process.exit(1);
    }
    console.log(`data/nutrients.json is up to date (${built.nutrients.length} nutrients).`);
    return;
  }
  writeFileSync(OUT, text);
  console.log(`Wrote data/nutrients.json (${built.nutrients.length} nutrients, ${built.nutrients.filter((n) => n.dri).length} with DRIs).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
