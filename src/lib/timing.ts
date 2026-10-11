/**
 * When to take what: timing statements from the NIH ODS fact sheets that apply
 * to this stack (calcium dose size and form, calcium and iron, iron and zinc,
 * iron with food, vitamin D with fat, green tea extract with food), plus the
 * medication timing NIH gives for in-stack interactions. Each tip cites its
 * fact sheet and names the products it is about. Statements, not a schedule.
 */
import { productName } from './advise.js';
import type { StackAnalysis, StackProduct } from './analyze.js';
import type { BotanicalDetection } from './botanicals.js';
import type { InteractionFinding } from './interactions.js';
import { num } from './advise.js';
import { tr } from './summary-es.js';

export interface TimingTip {
  id: string;
  nutrient_ids: string[];
  product_refs: string[];
  advice: string;
  advice_es: string;
  source: { name: string; url: string };
  /** false: listed here but not relayed in agent_summary. */
  relay?: boolean;
}

const ODS = (name: string, slug: string) => ({ name: `NIH Office of Dietary Supplements: ${name} fact sheet`, url: `https://ods.od.nih.gov/factsheets/${slug}-HealthProfessional/` });
const CALCIUM = ODS('Calcium', 'Calcium');
const IRON = ODS('Iron', 'Iron');
const ZINC = ODS('Zinc', 'Zinc');
const VITD = ODS('Vitamin D', 'VitaminD');
const WEIGHT = { name: 'NIH Office of Dietary Supplements: Dietary Supplements for Weight Loss fact sheet', url: 'https://ods.od.nih.gov/factsheets/WeightLoss-HealthProfessional/' };

interface Row {
  ref: string;
  name: string;
  perServing: number;
  names: string[];
}

/** Products supplying a nutrient, with the amount per serving (canonical unit) and the declared names and forms. */
function rows(products: StackProduct[], nutrientId: string): Row[] {
  const out: Row[] = [];
  for (const p of products) {
    const ings = p.label.ingredients.filter((i) => i.nutrient_id === nutrientId && i.per_serving);
    if (!ings.length) continue;
    out.push({
      ref: p.label.product_ref,
      name: productName({ brand: p.label.brand, name: p.label.name }),
      perServing: ings.reduce((s, i) => s + i.per_serving!.amount, 0),
      names: ings.flatMap((i) => [i.label_name, ...i.forms]).map((x) => x.toLowerCase()),
    });
  }
  return out;
}

const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const listEs = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]}`);

export function timingTips(a: StackAnalysis, products: StackProduct[], botanicals: BotanicalDetection[], findings: InteractionFinding[]): TimingTip[] {
  const tips: TimingTip[] = [];
  const ca = rows(products, 'calcium');
  const fe = rows(products, 'iron');
  const zn = rows(products, 'zinc');
  const d = rows(products, 'vitamin-d');

  const bigCa = ca.filter((r) => r.perServing > 500);
  if (bigCa.length) {
    tips.push({
      id: 'calcium_dose_size',
      nutrient_ids: ['calcium'],
      product_refs: bigCa.map((r) => r.ref),
      advice: `Calcium is absorbed best in doses of 500 mg or less; ${list(bigCa.map((r) => `${r.name} has ${num(r.perServing)} mg per serving`))}.`,
      advice_es: `El calcio se absorbe mejor en dosis de 500 mg o menos; ${listEs(bigCa.map((r) => `${r.name} aporta ${num(r.perServing)} mg por porción`))}.`,
      source: CALCIUM,
    });
  }
  const carbonate = ca.filter((r) => r.names.some((n) => /\bcarbonate\b/.test(n)));
  if (carbonate.length) {
    tips.push({
      id: 'calcium_carbonate_with_food',
      nutrient_ids: ['calcium'],
      product_refs: carbonate.map((r) => r.ref),
      advice: `Calcium carbonate (in ${list(carbonate.map((r) => r.name))}) is absorbed best with a meal; calcium citrate can be taken with or without food.`,
      advice_es: `El carbonato de calcio (en ${listEs(carbonate.map((r) => r.name))}) se absorbe mejor con una comida; el citrato de calcio puede tomarse con o sin alimentos.`,
      source: CALCIUM,
    });
  }
  const separateCaFe = ca.some((c) => fe.some((f) => f.ref !== c.ref));
  if (separateCaFe) {
    tips.push({
      id: 'calcium_iron_apart',
      nutrient_ids: ['calcium', 'iron'],
      product_refs: [...new Set([...ca, ...fe].map((r) => r.ref))],
      advice: 'Calcium might reduce iron absorption; experts suggest taking separate calcium and iron supplements at different times of the day.',
      advice_es: 'El calcio podría reducir la absorción del hierro; los expertos sugieren tomar los suplementos de calcio y de hierro por separado, en distintos momentos del día.',
      source: IRON,
    });
  }
  const bigFe = fe.filter((r) => r.perServing >= 25);
  if (bigFe.length && zn.some((z) => bigFe.some((f) => f.ref !== z.ref))) {
    tips.push({
      id: 'iron_zinc_apart',
      nutrient_ids: ['iron', 'zinc'],
      product_refs: [...new Set([...bigFe, ...zn].map((r) => r.ref))],
      advice: `25 mg or more of iron taken at the same time as zinc supplements can reduce zinc absorption (${list(bigFe.map((r) => `${r.name}: ${num(r.perServing)} mg iron per serving`))}); take them at different times.`,
      advice_es: `25 mg o más de hierro tomados a la vez que suplementos de zinc pueden reducir la absorción del zinc (${listEs(bigFe.map((r) => `${r.name}: ${num(r.perServing)} mg de hierro por porción`))}); tómelos en momentos distintos.`,
      source: ZINC,
    });
  }
  const ironDaily = a.nutrient_totals.find((t) => t.nutrient_id === 'iron')?.daily_total.amount ?? 0;
  if (ironDaily >= 45) {
    tips.push({
      id: 'iron_with_food',
      nutrient_ids: ['iron'],
      product_refs: fe.map((r) => r.ref),
      advice: `At ${num(ironDaily)} mg of iron a day, stomach upset and constipation are common; taking iron with food can help.`,
      advice_es: `Con ${num(ironDaily)} mg de hierro al día son frecuentes las molestias de estómago y el estreñimiento; tomar el hierro con alimentos puede ayudar.`,
      source: IRON,
    });
  }
  if (d.length) {
    tips.push({
      id: 'vitamin_d_with_fat',
      nutrient_ids: ['vitamin-d'],
      product_refs: d.map((r) => r.ref),
      advice: 'Fat in the gut enhances vitamin D absorption, so taking it with a meal that contains some fat may help (some is absorbed without fat).',
      advice_es: 'La grasa en el intestino mejora la absorción de la vitamina D, así que tomarla con una comida que tenga algo de grasa puede ayudar (algo se absorbe sin grasa).',
      source: VITD,
    });
  }
  const gte = botanicals.find((b) => b.id === 'green-tea-extract');
  if (gte) {
    tips.push({
      id: 'green_tea_extract_with_food',
      nutrient_ids: [],
      product_refs: gte.product_refs,
      advice: 'Take green tea extract with food: liver problems are more likely when it is taken on an empty stomach (USP, cited by NIH ODS).',
      advice_es: 'Tome el extracto de té verde con alimentos: los problemas hepáticos son más probables si se toma en ayunas (USP, citado por NIH ODS).',
      source: WEIGHT,
      // Small amounts are common in multivitamins; relay it only when the EGCG dose check applies.
      ...(gte.dose_findings.length ? {} : { relay: false }),
    });
  }
  // Medication timing NIH gives for interactions with something in the stack.
  const seen = new Set<string>();
  for (const f of findings) {
    if (!f.in_stack || !f.timing) continue;
    const key = `${f.trigger}|${f.timing}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tips.push({
      id: 'medication_timing',
      nutrient_ids: f.nutrient_ids,
      product_refs: f.product_refs,
      advice: `${f.trigger}: ${f.timing}`,
      advice_es: `${f.trigger}: ${tr(f.timing)}`,
      source: f.source,
    });
  }
  return tips;
}
