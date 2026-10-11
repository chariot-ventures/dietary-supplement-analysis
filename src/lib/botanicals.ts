/**
 * Botanicals and other non-nutrient ingredients with safety signals in NIH
 * NCCIH and ODS fact sheets (data/botanicals.json).
 *
 * Matching is exact: the DSLD ingredient group (e.g. "Ashwagandha") or the
 * label name must equal a listed name after normalization and after dropping
 * trailing plant-part or preparation words from a closed list ("root",
 * "extract", "powder"...). "Ashwagandha Root Extract" matches; "Garcinia
 * mangostana" does not match garcinia cambogia.
 */
import data from '../../data/botanicals.json' with { type: 'json' };
import type { StackProduct } from './analyze.js';
import type { Amount } from './label.js';
import { normalizeName, round } from './text.js';
import { convertMass, parseUnit } from './units.js';

interface Ref {
  name: string;
  url: string;
}
interface BotanicalMed {
  class: string;
  kind?: string;
  summary: string;
}
interface DoseCheck {
  match: string[];
  min_daily: { amount: number; unit: 'mg' };
  summary: string;
  source: Ref;
}
interface Botanical {
  name: string;
  match: string[];
  signals: { kind: string; summary: string; relay?: boolean }[];
  pregnancy: string | null;
  medications: BotanicalMed[];
  dose_checks?: DoseCheck[];
  source: Ref;
}
interface BotanicalsFile {
  reviewed: string;
  descriptor_words: string[];
  botanicals: Record<string, Botanical>;
}
const file = data as unknown as BotanicalsFile;
export const BOTANICALS_REVIEWED = file.reviewed;
export const BOTANICALS = file.botanicals;

const DESCRIPTORS = new Set(file.descriptor_words);

/** normalizeName plus apostrophes and periods removed: "St. John's Wort" -> "st johns wort". */
export function normalizeBotanical(s: string): string {
  return normalizeName(s)
    .replace(/[.'’`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The name and its shorter forms with trailing (and leading) descriptor words removed, longest first. */
export function nameForms(raw: string): string[] {
  let words = normalizeBotanical(raw).split(' ').filter(Boolean);
  while (words.length > 1 && DESCRIPTORS.has(words[0]!)) words = words.slice(1);
  const out = [words.join(' ')];
  while (words.length > 1 && DESCRIPTORS.has(words[words.length - 1]!)) {
    words = words.slice(0, -1);
    out.push(words.join(' '));
  }
  return out;
}

const byName = new Map<string, string>();
for (const [id, b] of Object.entries(file.botanicals)) {
  for (const m of [b.name, ...b.match]) byName.set(normalizeBotanical(m), id);
}

/** Botanical id and the listed name it matched, or null. */
export function matchBotanical(names: (string | null | undefined)[]): { id: string; term: string } | null {
  for (const n of names) {
    if (!n) continue;
    for (const form of nameForms(n)) {
      const id = byName.get(form);
      if (id) return { id, term: form };
    }
  }
  return null;
}

export interface BotanicalSignal {
  kind: string;
  summary: string;
  /** false: listed here but not relayed in agent_summary (see data/botanicals.json). */
  relay?: boolean;
}

export interface BotanicalDetection {
  id: string;
  name: string;
  product_refs: string[];
  label_names: string[];
  signals: BotanicalSignal[];
  /** NCCIH or ODS statement on pregnancy and breastfeeding, when there is one. */
  pregnancy: string | null;
  /** Dose statements that apply at the amount in this stack. */
  dose_findings: { daily: Amount; threshold: Amount; summary: string; source: Ref }[];
  source: Ref;
}

function toMg(a: Amount | null): number | null {
  if (!a) return null;
  const u = parseUnit(a.unit);
  return u.kind === 'mass' && u.basis === null ? convertMass(a.amount, u.unit, 'mg') : null;
}

/**
 * Botanicals in the stack's unrecognized ingredients. `spd`: servings per day
 * used for each product_ref (from the analysis).
 */
export function detectBotanicals(products: StackProduct[], spd: Map<string, number>): BotanicalDetection[] {
  const found = new Map<string, BotanicalDetection & { amounts: { term: string; mg: number | null }[] }>();
  for (const p of products) {
    const ref = p.label.product_ref;
    for (const u of p.label.unrecognized_ingredients) {
      if (u.is_blend) continue;
      const m = matchBotanical([u.ingredient_group, u.label_name]) ?? null;
      if (!m) continue;
      const b = file.botanicals[m.id]!;
      let d = found.get(m.id);
      if (!d) {
        d = { id: m.id, name: b.name, product_refs: [], label_names: [], signals: b.signals, pregnancy: b.pregnancy, dose_findings: [], source: b.source, amounts: [] };
        found.set(m.id, d);
      }
      if (!d.product_refs.includes(ref)) d.product_refs.push(ref);
      if (!d.label_names.includes(u.label_name)) d.label_names.push(u.label_name);
      const mg = toMg(u.per_serving);
      // The row's own name decides which dose check it counts toward (EGCG vs whole extract).
      const term = matchBotanical([u.label_name])?.term ?? m.term;
      d.amounts.push({ term, mg: mg === null ? null : mg * (spd.get(ref) ?? 1) });
    }
  }
  const out: BotanicalDetection[] = [];
  for (const d of found.values()) {
    const b = file.botanicals[d.id]!;
    for (const check of b.dose_checks ?? []) {
      const terms = new Set(check.match.map(normalizeBotanical));
      const rows = d.amounts.filter((a) => terms.has(a.term) && a.mg !== null);
      const total = rows.reduce((s, a) => s + a.mg!, 0);
      if (rows.length && total >= check.min_daily.amount) {
        d.dose_findings.push({ daily: { amount: round(total, 1), unit: 'mg' }, threshold: check.min_daily, summary: check.summary, source: check.source });
      }
    }
    // Only the highest applicable dose statement per botanical.
    if (d.dose_findings.length > 1) d.dose_findings = [d.dose_findings.sort((x, y) => y.threshold.amount - x.threshold.amount)[0]!];
    const rest: BotanicalDetection = { id: d.id, name: d.name, product_refs: d.product_refs, label_names: d.label_names, signals: d.signals, pregnancy: d.pregnancy, dose_findings: d.dose_findings, source: d.source };
    // Nothing NIH says applies (creatine within the usual dose): not reported.
    if (rest.signals.length || rest.dose_findings.length || rest.pregnancy) out.push(rest);
  }
  return out;
}

/** Botanical-medication interactions for detected (or, for the check endpoint, requested) botanicals. */
export function botanicalMedicationPairs(botanicalIds: string[], classIds: Set<string>): { id: string; med: BotanicalMed; source: Ref }[] {
  const out: { id: string; med: BotanicalMed; source: Ref }[] = [];
  for (const id of botanicalIds) {
    const b = file.botanicals[id];
    if (!b) continue;
    for (const med of b.medications) if (classIds.has(med.class)) out.push({ id, med, source: b.source });
  }
  return out;
}

export function allBotanicalClasses(): Set<string> {
  return new Set(Object.values(file.botanicals).flatMap((b) => b.medications.map((m) => m.class)));
}
