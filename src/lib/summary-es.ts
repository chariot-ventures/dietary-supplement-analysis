/**
 * Spanish agent_summary ("lang": "es"). Mirrors agentSummary() in advise.ts
 * sentence for sentence, built from the same structured results. Data phrases
 * (nutrient names, UL bases, NIH statements) come from data/i18n-es.json; a
 * test checks that every phrase that can reach a summary has a translation.
 *
 * Wording rule as in English: never "seguro" about a stack or "sin riesgo".
 */
import es from '../../data/i18n-es.json' with { type: 'json' };
import { botanicalRank, firstSentence, num, productName, towardByProduct, type SummaryContext } from './advise.js';
import type { NutrientTotal, StackAnalysis } from './analyze.js';
import type { BotanicalDetection } from './botanicals.js';
import { BOTANICALS } from './botanicals.js';
import type { InteractionFinding } from './interactions.js';
import { nutrientIndex } from './nutrients.js';

const TM = es as Record<string, string>;
/** Spanish for a data phrase; the English original when there is none. */
export const tr = (s: string): string => TM[s] ?? s;
export const hasTranslation = (s: string): boolean => s in TM;

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const lower = (s: string) => (s ? s[0]!.toLowerCase() + s.slice(1) : s);
/** Spanish nutrient name, lowercase except for vitamin/acronym names ("zinc", "Vitamina D" -> "vitamina D"). */
const nName = (id: string, fallback: string) => {
  const n = tr(nutrientIndex.get(id)?.name ?? fallback);
  return /^(DHA|EPA)/.test(n) ? n : lower(n);
};
const nameOfT = (t: NutrientTotal) => nName(t.nutrient_id, t.name);
const pct = (v: number) => `${num(v)}%`;
const unitEs = (u: string) => u;

export function describeProfileEs(p: { age: number; sex: string; life_stage?: string | null }): string {
  if (p.age < 1) return `un bebé de ${Math.floor(p.age * 12)} meses`;
  if (p.life_stage === 'pregnancy') return `una embarazada de ${num(p.age)} años`;
  if (p.life_stage === 'lactation') return `una mujer de ${num(p.age)} años en lactancia`;
  return p.sex === 'female' ? `una mujer de ${num(p.age)} años` : `un hombre de ${num(p.age)} años`;
}

function suggestionEs(s: SummaryContext['suggestions'][number], t: NutrientTotal): string {
  const ul = t.reference!.ul!;
  const v = s.result.amount_toward_ul.amount;
  const p = (v / ul) * 100;
  const what = `${nameOfT(t)} a ${num(v)} ${unitEs(s.result.amount_toward_ul.unit)} (${pct(p)} del UL`;
  if (s.action === 'reduce_servings') {
    return `Tomar ${s.servings_per_day} ${s.servings_per_day === 1 ? 'porción' : 'porciones'} al día de ${s.product_name} dejaría ${what}${p >= 90 ? ', aún cerca' : ''}).`;
  }
  return `Prescindir de ${s.product_name} dejaría ${what})${s.resolves ? (p >= 90 ? ', aún cerca del UL' : '') : ', aún por encima'}${s.also_resolves.length ? `, y también dejaría ${s.also_resolves.map((id) => nName(id, id)).join(', ')} en el UL o por debajo` : ''}.`;
}

function candidateEs(c: SummaryContext['candidates'][number]): string {
  const d = (f: (typeof c.new_flags)[number]) => `${nName(f.nutrient_id, f.name)} (${f.percent_of_ul === null ? 'por encima' : `${pct(f.percent_of_ul)}`} del UL)`;
  switch (c.verdict) {
    case 'adds_above_ul':
      return `Añadir ${c.product_name} pondría ${c.new_flags.filter((f) => f.flag === 'above_ul').map(d).join(', ')} por encima del límite superior.`;
    case 'increases_above_ul':
      return `Añadir ${c.product_name} sumaría a nutrientes que ya superan el límite superior.`;
    case 'adds_near_ul':
      return `Añadir ${c.product_name} dejaría ${c.new_flags.map(d).join(', ')} a menos de un 10% del límite superior.`;
    default:
      return `Añadir ${c.product_name} no lleva ningún nutriente al límite superior ni cerca de él para este perfil.`;
  }
}

function botanicalSentencesEs(found: BotanicalDetection[], a: StackAnalysis, pregnancy: boolean): string[] {
  const names = new Map(a.products.map((p) => [p.product_ref, productName(p)]));
  const out: string[] = [];
  const ranked = [...found].sort((x, y) => botanicalRank(x) - botanicalRank(y));
  for (const b of ranked.slice(0, 3)) {
    const notes = [b.dose_findings[0]?.summary, b.signals.find((s) => s.relay !== false)?.summary, pregnancy ? b.pregnancy : null].filter((x): x is string => Boolean(x));
    if (!notes.length) continue;
    out.push(`${tr(b.name)} (en ${b.product_refs.map((r) => names.get(r) ?? r).join(', ')}): ${notes.map((n) => tr(firstSentence(n))).join(' ')}`);
  }
  if (found.length > 3) out.push(`Hay ${found.length - 3} plantas más en botanicals.`);
  return out;
}

const BOT_NAMES = new Map(Object.entries(BOTANICALS).map(([id, b]) => [id, b.name]));

function interactionSentencesEs(ix: NonNullable<SummaryContext['interactions']>): string[] {
  const out: string[] = [];
  const meds = ix.findings.filter((f: InteractionFinding) => f.type === 'medication');
  if (ix.medicationsGiven && !meds.length) {
    out.push('Las fichas de los NIH no recogen ninguna interacción entre los medicamentos indicados y los nutrientes de este conjunto (la lista no es exhaustiva).');
  }
  for (const f of ix.findings.slice(0, 3)) {
    const what = [...f.nutrient_ids.map((id) => nName(id, id)), ...f.botanical_ids.map((id) => lower(tr(BOT_NAMES.get(id) ?? id)))].join('/');
    const lead = f.type === 'medication' ? `${cap(f.trigger)} con ${what} de este conjunto` : `${cap(what)} de este conjunto (${lower(tr(f.trigger_name.replace(/\s*\(.*\)$/, '')))})`;
    out.push(`${lead}: ${tr(firstSentence(f.summary))}${f.timing ? ` ${tr(f.timing)}` : ''}`);
  }
  const more = ix.findings.length - 3;
  if (more > 0) out.push(`${more} ${more === 1 ? 'hallazgo más' : 'hallazgos más'} en interactions.findings.`);
  if (ix.unrecognized.length) out.push(`No reconocidos, así que no se revisaron: ${ix.unrecognized.map((u) => `"${u}"`).join(', ')}.`);
  return out;
}

export function agentSummaryEs(a: StackAnalysis, ctx: SummaryContext): string {
  const parts: string[] = [];
  const above = a.nutrient_totals.filter((t) => t.flags.includes('above_ul'));
  const near = a.nutrient_totals.filter((t) => t.flags.includes('near_ul'));
  const names = new Map(a.products.map((p) => [p.product_ref, productName(p)]));
  const byId = new Map(a.nutrient_totals.map((t) => [t.nutrient_id, t]));

  if (!a.profile) {
    parts.push(`${a.products.length === 1 ? 'Este producto aporta' : `Estos ${a.products.length} productos aportan`} ${a.nutrient_totals.length} vitaminas y minerales; sin edad y sexo no se compararon los totales con los límites superiores.`);
  } else if (above.length) {
    const who = describeProfileEs(a.profile);
    parts.push(`${above.length === 1 ? '1 nutriente supera' : `${above.length} nutrientes superan`} el nivel máximo de ingesta tolerable (UL) para ${who} solo con estos suplementos.`);
    for (const t of above.slice(0, 3)) {
      const main = [...towardByProduct(t)].filter(([, v]) => v.toward !== null).sort((x, y) => (y[1].toward ?? 0) - (x[1].toward ?? 0))[0];
      const share = main && t.amount_toward_ul && t.amount_toward_ul.amount > 0 ? (main[1].toward ?? 0) / t.amount_toward_ul.amount : 0;
      const from = main && share >= 0.5 && t.contributions.length > 1 ? `, sobre todo de ${names.get(main[0]) ?? main[0]}` : '';
      const unit = t.amount_toward_ul?.unit ?? t.daily_total.unit;
      const p = t.percent_of_ul !== null ? ` (${pct(t.percent_of_ul)})` : '';
      const basis = t.reference?.ul_basis ? ` El UL protege frente a: ${lower(tr(t.reference.ul_basis))}.` : '';
      parts.push(`${cap(nameOfT(t))}: ${num(t.amount_toward_ul?.amount ?? t.daily_total.amount)} ${unit} al día frente a un UL de ${num(t.reference!.ul!)} ${t.reference!.ul_unit ?? unit}${p}${from}.${basis}`);
    }
    if (above.length > 3) parts.push(`Hay ${above.length - 3} más en nutrient_totals.`);
    const fix = ctx.suggestions.find((s) => s.resolves);
    const ft = fix ? byId.get(fix.nutrient_id) : undefined;
    if (fix && ft) parts.push(suggestionEs(fix, ft));
  } else {
    parts.push(`Ningún nutriente de estos suplementos supera su nivel máximo (UL) para ${describeProfileEs(a.profile)}.`);
  }
  if (near.length) {
    parts.push(`${cap(near.map((t) => `${nameOfT(t)} (${pct(t.percent_of_ul ?? 0)})`).join(', '))} ${near.length === 1 ? 'está' : 'están'} a menos de un 10% del UL.`);
  }
  if (ctx.dietFlags?.length) {
    const items = ctx.dietFlags.map((d) => `${lower(tr(d.name))} ${d.flag === 'above_ul' ? 'superaría' : 'estaría cerca de'} su UL${d.percent_of_ul === null ? '' : ` (${pct(d.percent_of_ul)})`}`);
    parts.push(`Sumando la ingesta media de alimentos y bebidas en EE. UU., ${items.join('; ')}.`);
  }
  if (ctx.foods?.flags.length) {
    const items = ctx.foods.flags.map((d) => `${nName(d.nutrient_id, d.name)} ${d.flag === 'above_ul' ? 'superaría' : 'estaría cerca de'} su UL${d.percent_of_ul === null ? '' : ` (${pct(d.percent_of_ul)})`}`);
    parts.push(`Sumando los alimentos indicados, ${items.join('; ')}.`);
  }
  if (ctx.foods?.unresolved.length) parts.push(`Alimentos no contados (no encontrados, o sin porción del USDA para la unidad indicada): ${ctx.foods.unresolved.map((u) => `"${u}"`).join(', ')}.`);
  if (ctx.botanicals?.length) parts.push(...botanicalSentencesEs(ctx.botanicals, a, ctx.pregnancyOrLactation ?? false));
  if (ctx.interactions) parts.push(...interactionSentencesEs(ctx.interactions));
  const tip = ctx.timing?.find((t) => t.id !== 'medication_timing' && t.relay !== false);
  if (tip) parts.push(`Momento de toma${ctx.timing!.length > 1 ? ` (1 de ${ctx.timing!.length} consejos en timing)` : ''}: ${tip.advice_es}`);
  for (const c of ctx.candidates) parts.push(candidateEs(c));
  if (ctx.unresolved.length) parts.push(`No identificados, así que no se contaron: ${ctx.unresolved.map((u) => `"${u}"`).join(', ')}.`);
  if (ctx.lowConfidence.length) {
    parts.push(`Coincidencia dudosa: ${ctx.lowConfidence.map((l) => `"${l.input}" se interpretó como ${l.chosen}`).join('; ')}; confírmelo con la persona (ver resolutions).`);
  }
  if (a.summary.data_suspect) {
    parts.push(`${a.summary.data_suspect === 1 ? '1 dato de etiqueta parece incoherente' : `${a.summary.data_suspect} datos de etiqueta parecen incoherentes`} en la base de datos de los NIH (DATA_SUSPECT en data_gaps); revise la etiqueta antes de fiarse.`);
  }
  const medNote = ctx.interactions?.medicationsGiven ? ' La revisión de medicamentos cubre solo las interacciones que recogen las fichas de los NIH; un farmacéutico puede revisar la lista completa.' : '';
  parts.push(
    ctx.dietApplied
      ? `Los totales de suplementos no incluyen medicamentos; la estimación de alimentos es una media de EE. UU., no la dieta de esta persona.${medNote} Datos de etiquetas, no consejo médico.`
      : ctx.foods?.applied
        ? `Los totales de suplementos no incluyen medicamentos; with_foods suma solo los alimentos indicados.${medNote} Datos de etiquetas, no consejo médico.`
        : `Los totales no incluyen alimentos, bebidas ni medicamentos.${medNote} Datos de etiquetas, no consejo médico.`,
  );
  return parts.join(' ');
}
