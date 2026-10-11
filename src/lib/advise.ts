/**
 * Turns a stack analysis into what an agent acts on: deterministic changes
 * that bring an above-UL nutrient back under its UL, the effect of adding a
 * candidate product, and a short plain-language summary.
 *
 * Wording rule (as in analyze.ts): never "safe" or "no risk". Suggestions are
 * phrased as arithmetic ("would bring zinc to 15 mg"), not as advice.
 */
import type { Amount } from './label.js';
import type { NutrientTotal, ProductSummary, StackAnalysis } from './analyze.js';
import { round } from './text.js';

export interface Suggestion {
  nutrient_id: string;
  action: 'reduce_servings' | 'remove_product';
  product_ref: string;
  product_name: string;
  /** reduce_servings only: the new servings per day. */
  servings_per_day?: number;
  /** True when this change alone brings the amount toward the UL to or under the UL. */
  resolves: boolean;
  result: { amount_toward_ul: Amount; percent_of_ul: number };
  /** Other above-UL nutrients this same change brings to or under their UL. */
  also_resolves: string[];
  /** remove_product only: other nutrients this product supplies, which removing it would also lower. */
  also_lowers: string[];
  text: string;
}

export type CandidateVerdict = 'adds_above_ul' | 'increases_above_ul' | 'adds_near_ul' | 'no_new_flags';

export interface CandidateResult {
  product_ref: string;
  product_name: string;
  verdict: CandidateVerdict;
  new_flags: { nutrient_id: string; name: string; flag: string; percent_of_ul: number | null }[];
  changes: {
    nutrient_id: string;
    from: Amount;
    to: Amount;
    percent_of_ul_to: number | null;
    coverage_percent_to: number | null;
  }[];
  text: string;
}

const MAX_SUGGESTIONS_PER_NUTRIENT = 3;

export function productName(p: Pick<ProductSummary, 'brand' | 'name'>): string {
  if (!p.brand) return p.name;
  return p.name.toLowerCase().startsWith(p.brand.toLowerCase()) ? p.name : `${p.brand} ${p.name}`;
}

/** Display a number with sensible precision: 115, 2.4, 0.35. */
export function num(v: number): string {
  const r = Math.abs(v) >= 100 ? round(v, 0) : Math.abs(v) >= 10 ? round(v, 1) : round(v, 2);
  return String(r);
}

const lower = (s: string) => (s ? s[0]!.toLowerCase() + s.slice(1) : s);
const nameOf = (t: NutrientTotal) => (/^[A-Z][a-z]/.test(t.name) && !/^Vitamin|^DHA|^EPA/.test(t.name) ? t.name.toLowerCase() : t.name);

/** Daily amount toward the UL that each product contributes; null when a product's UL portion is unknown. */
function towardByProduct(t: NutrientTotal): Map<string, { toward: number | null; spd: number }> {
  const m = new Map<string, { toward: number | null; spd: number }>();
  for (const c of t.contributions) {
    const cur = m.get(c.product_ref) ?? { toward: 0, spd: c.servings_per_day };
    cur.toward = cur.toward === null || c.daily_toward_ul === null ? null : cur.toward + c.daily_toward_ul;
    m.set(c.product_ref, cur);
  }
  return m;
}

function ulOf(t: NutrientTotal): number | null {
  return t.reference?.ul ?? null;
}

/** For each above-UL nutrient: changes to one product that would bring it to or under the UL, best first. */
export function suggestFixes(a: StackAnalysis): Suggestion[] {
  const above = a.nutrient_totals.filter((t) => t.flags.includes('above_ul') && ulOf(t) !== null && t.amount_toward_ul);
  const names = new Map(a.products.map((p) => [p.product_ref, productName(p)]));
  const out: Suggestion[] = [];

  for (const t of above) {
    const ul = ulOf(t)!;
    const total = t.amount_toward_ul!.amount;
    const unit = t.amount_toward_ul!.unit;
    const options: Suggestion[] = [];

    for (const [ref, { toward, spd }] of towardByProduct(t)) {
      if (toward === null || toward <= 0) continue;
      const name = names.get(ref) ?? ref;
      const perServing = toward / spd;
      const effectOn = (u: NutrientTotal, keepServings: number): number | null => {
        const entry = towardByProduct(u).get(ref);
        if (!entry || entry.toward === null || !u.amount_toward_ul) return null;
        return u.amount_toward_ul.amount - entry.toward + (entry.toward / entry.spd) * keepServings;
      };
      const alsoResolves = (keep: number) =>
        above.filter((u) => u !== t).filter((u) => {
          const v = effectOn(u, keep);
          return v !== null && v <= ulOf(u)!;
        }).map((u) => u.nutrient_id);

      // Fewer servings, when the label (or caller) has more than one a day.
      if (spd > 1) {
        const keep = Math.floor((ul - (total - toward)) / perServing + 1e-9);
        if (keep >= 1 && keep < spd) {
          const v = round(total - toward + perServing * keep, 4);
          options.push({
            nutrient_id: t.nutrient_id,
            action: 'reduce_servings',
            product_ref: ref,
            product_name: name,
            servings_per_day: keep,
            resolves: true,
            result: { amount_toward_ul: { amount: v, unit }, percent_of_ul: round((v / ul) * 100, 1) },
            also_resolves: alsoResolves(keep),
            also_lowers: [],
            text: `Taking ${keep} serving${keep === 1 ? '' : 's'} a day of ${name} instead of ${num(spd)} would bring ${nameOf(t)} to ${num(v)} ${unit} (${num((v / ul) * 100)}% of the UL${(v / ul) * 100 >= 90 ? ', still near it' : ''}).`,
          });
        }
      }

      // Leaving the product out.
      const v = round(total - toward, 4);
      const resolves = v <= ul;
      const lowers = a.nutrient_totals.filter((u) => u !== t && u.contributions.some((c) => c.product_ref === ref)).map((u) => u.nutrient_id);
      const also = alsoResolves(0);
      options.push({
        nutrient_id: t.nutrient_id,
        action: 'remove_product',
        product_ref: ref,
        product_name: name,
        resolves,
        result: { amount_toward_ul: { amount: v, unit }, percent_of_ul: round((v / ul) * 100, 1) },
        also_resolves: also,
        also_lowers: lowers,
        text:
          `Leaving out ${name} would bring ${nameOf(t)} to ${num(v)} ${unit} (${num((v / ul) * 100)}% of the UL)` +
          (resolves ? ((v / ul) * 100 >= 90 ? ', still near it' : '') : ', still above it') +
          (also.length ? `, and would also bring ${also.join(', ')} to or under the UL` : '') +
          '.',
      });
    }

    options.sort(
      (x, y) =>
        Number(y.resolves) - Number(x.resolves) ||
        y.also_resolves.length - x.also_resolves.length ||
        Number(x.action === 'remove_product') - Number(y.action === 'remove_product') ||
        x.also_lowers.length - y.also_lowers.length ||
        x.result.amount_toward_ul.amount - y.result.amount_toward_ul.amount,
    );
    // When nothing resolves it alone, the biggest contributor is still the most useful single change.
    if (!options.some((o) => o.resolves)) options.sort((x, y) => x.result.amount_toward_ul.amount - y.result.amount_toward_ul.amount);
    out.push(...options.slice(0, MAX_SUGGESTIONS_PER_NUTRIENT));
  }
  return out;
}

/** What adding one candidate product changes, compared with the stack without it. */
export function compareCandidate(base: StackAnalysis, combined: StackAnalysis, candidate: ProductSummary): CandidateResult {
  const before = new Map(base.nutrient_totals.map((t) => [t.nutrient_id, t]));
  const name = productName(candidate);
  const newFlags: CandidateResult['new_flags'] = [];
  const changes: CandidateResult['changes'] = [];
  let increasesAbove = false;

  for (const t of combined.nutrient_totals) {
    if (!t.contributions.some((c) => c.product_ref === candidate.product_ref)) continue;
    const b = before.get(t.nutrient_id);
    changes.push({
      nutrient_id: t.nutrient_id,
      from: b ? b.daily_total : { amount: 0, unit: t.daily_total.unit },
      to: t.daily_total,
      percent_of_ul_to: t.percent_of_ul,
      coverage_percent_to: t.coverage?.percent ?? null,
    });
    for (const f of t.flags) {
      if (!b?.flags.includes(f) && !(f === 'near_ul' && b?.flags.includes('above_ul'))) newFlags.push({ nutrient_id: t.nutrient_id, name: nameOf(t), flag: f, percent_of_ul: t.percent_of_ul });
    }
    if (b?.flags.includes('above_ul')) increasesAbove = true;
  }

  const verdict: CandidateVerdict = newFlags.some((f) => f.flag === 'above_ul')
    ? 'adds_above_ul'
    : increasesAbove
      ? 'increases_above_ul'
      : newFlags.length
        ? 'adds_near_ul'
        : 'no_new_flags';
  const describe = (f: CandidateResult['new_flags'][number]) => `${f.name} (${f.percent_of_ul === null ? 'over' : `${num(f.percent_of_ul)}% of`} the UL)`;
  const text =
    verdict === 'adds_above_ul'
      ? `Adding ${name} would put ${newFlags.filter((f) => f.flag === 'above_ul').map(describe).join(', ')} above the upper limit.`
      : verdict === 'increases_above_ul'
        ? `Adding ${name} would add to nutrients that are already above the upper limit.`
        : verdict === 'adds_near_ul'
          ? `Adding ${name} would bring ${newFlags.map(describe).join(', ')} within 10% of the upper limit.`
          : `Adding ${name} raises no nutrient to or near its upper limit for this profile.`;
  return { product_ref: candidate.product_ref, product_name: name, verdict, new_flags: newFlags, changes, text };
}

/** "a 34-year-old female", "a pregnant 30-year-old", "a 6-month-old infant". */
export function describeProfile(p: { age: number; sex: string; life_stage?: string | null }): string {
  if (p.age < 1) return `a ${Math.floor(p.age * 12)}-month-old infant`;
  if (p.life_stage === 'pregnancy') return `a pregnant ${num(p.age)}-year-old`;
  if (p.life_stage === 'lactation') return `a breastfeeding ${num(p.age)}-year-old`;
  return `a ${num(p.age)}-year-old ${p.sex}`;
}

export interface SummaryContext {
  /** Nutrients flagged only once typical food intake is added (diet "typical"). */
  dietFlags?: { name: string; percent_of_ul: number | null; flag: string }[];
  /** True when diet "typical" estimates were added. */
  dietApplied?: boolean;
  suggestions: Suggestion[];
  unresolved: string[];
  lowConfidence: { input: string; chosen: string }[];
  candidates: CandidateResult[];
}

/**
 * Two to five plain sentences an agent can relay as is. Deterministic: the
 * same analysis always gives the same text.
 */
export function agentSummary(a: StackAnalysis, ctx: SummaryContext): string {
  const parts: string[] = [];
  const who = a.profile ? `for ${describeProfile(a.profile)}` : '';
  const above = a.nutrient_totals.filter((t) => t.flags.includes('above_ul'));
  const near = a.nutrient_totals.filter((t) => t.flags.includes('near_ul'));
  const names = new Map(a.products.map((p) => [p.product_ref, productName(p)]));

  if (!a.profile) {
    parts.push(
      `These ${a.products.length} product${a.products.length === 1 ? '' : 's'} supply ${a.nutrient_totals.length} vitamins and minerals; without age and sex, totals were not compared with upper limits.`,
    );
  } else if (above.length) {
    parts.push(`${above.length} nutrient${above.length === 1 ? ' is' : 's are'} above the upper limit (UL) ${who} from these supplements alone.`);
    for (const t of above.slice(0, 3)) {
      const main = [...towardByProduct(t)].filter(([, v]) => v.toward !== null).sort((x, y) => (y[1].toward ?? 0) - (x[1].toward ?? 0))[0];
      const share = main && t.amount_toward_ul && t.amount_toward_ul.amount > 0 ? (main[1].toward ?? 0) / t.amount_toward_ul.amount : 0;
      const from = main && share >= 0.5 && t.contributions.length > 1 ? `, mostly from ${names.get(main[0]) ?? main[0]}` : '';
      const unit = t.amount_toward_ul?.unit ?? t.daily_total.unit;
      const pct = t.percent_of_ul !== null ? ` (${num(t.percent_of_ul)}%)` : '';
      const basis = t.reference?.ul_basis ? ` The UL guards against ${lower(t.reference.ul_basis)}.` : '';
      parts.push(`${t.name}: ${num(t.amount_toward_ul?.amount ?? t.daily_total.amount)} ${unit} a day vs a UL of ${num(t.reference!.ul!)} ${t.reference!.ul_unit ?? unit}${pct}${from}.${basis}`);
    }
    if (above.length > 3) parts.push(`${above.length - 3} more are listed in nutrient_totals.`);
    const fix = ctx.suggestions.find((s) => s.resolves);
    if (fix) parts.push(fix.text);
  } else {
    parts.push(`No nutrient in these supplements is above its upper limit (UL) ${who}.`);
  }
  if (near.length) {
    parts.push(`${near.map((t) => `${nameOf(t)} (${num(t.percent_of_ul ?? 0)}%)`).join(', ')} ${near.length === 1 ? 'is' : 'are'} within 10% of the UL.`);
  }
  if (ctx.dietFlags?.length) {
    const items = ctx.dietFlags.map((d) => `${d.name} would be ${d.flag === 'above_ul' ? 'above' : 'near'} its UL${d.percent_of_ul === null ? '' : ` (${num(d.percent_of_ul)}%)`}`);
    parts.push(`With average US food and drink intake added, ${items.join('; ')}.`);
  }
  for (const c of ctx.candidates) parts.push(c.text);
  if (ctx.unresolved.length) parts.push(`Not identified, so not counted: ${ctx.unresolved.map((u) => `"${u}"`).join(', ')}.`);
  if (ctx.lowConfidence.length) {
    parts.push(`Uncertain product match: ${ctx.lowConfidence.map((l) => `"${l.input}" was read as ${l.chosen}`).join('; ')}; confirm with the user (see resolutions).`);
  }
  if (a.summary.data_suspect) {
    parts.push(`${a.summary.data_suspect} label entr${a.summary.data_suspect === 1 ? 'y looks' : 'ies look'} inconsistent in the NIH database (DATA_SUSPECT in data_gaps); check the label before relying on ${a.summary.data_suspect === 1 ? 'it' : 'them'}.`);
  }
  parts.push(
    ctx.dietApplied
      ? 'Supplement totals exclude medications; the food estimate is a US average, not this person\'s diet. Label data, not medical advice.'
      : 'Totals exclude food, drinks and medications. Label data, not medical advice.',
  );
  return parts.join(' ');
}
