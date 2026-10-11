import type { FastifyInstance } from 'fastify';
import { agentSummary, compareCandidate, suggestFixes, type CandidateResult } from '../lib/advise.js';
import { analyzeStack, type Profile, type StackAnalysis, type StackProduct } from '../lib/analyze.js';
import { applyTypicalDiet, DIET_SOURCE, dietOnlyFlags } from '../lib/diet.js';
import { lookupUpc, resolveQuery, type Candidate, type Confidence } from '../lib/catalog.js';
import type { CallOptions, DsldClient, LabelResult } from '../lib/dsld.js';
import { AppError } from '../lib/errors.js';
import { dedupeSources, envelope, type Source } from '../lib/envelope.js';
import { normalizeCustomProduct, normalizeDsldLabel, type DataGap } from '../lib/label.js';
import { BOTANICALS_REVIEWED, detectBotanicals, type BotanicalDetection } from '../lib/botanicals.js';
import { conditionName, evaluateInteractions, INTERACTIONS_REVIEWED, matchMedications, type InteractionFinding, type MedicationMatch } from '../lib/interactions.js';
import { provenanceShort } from '../lib/provenance.js';
import { analyzeRequest, assertSupportedProfile, parseBody, type StackProductInput } from '../schemas/requests.js';
import { upstreamBudget, type Deps } from './deps.js';
import { INTERACTIONS_SCOPE } from './interactions.js';

export interface Resolution {
  /** Where the input was: "products.2" or "candidates.0". */
  input_path: string;
  input: { query: string; brand?: string } | { upc: string };
  status: 'resolved' | 'not_found';
  matched_by: 'query' | 'upc';
  dsld_id: number | null;
  product_ref: string | null;
  brand: string | null;
  name: string | null;
  entry_date: string | null;
  confidence: Confidence | null;
  reason: string;
  /** Older DSLD versions of the chosen product. */
  other_versions: number[];
  /** Other products the description could mean (query only). */
  alternatives: Omit<Candidate, 'other_versions'>[];
}

/** A request item after resolution: a DSLD ID, a custom product, or nothing (not found). */
type Resolved = { kind: 'dsld'; dsld_id: number; spd?: number | undefined } | { kind: 'custom'; item: Extract<StackProductInput, { ingredients: unknown }> } | { kind: 'none'; label: string };

async function resolveItem(item: StackProductInput, path: string, dsld: DsldClient, opts: CallOptions, resolutions: Resolution[]): Promise<Resolved> {
  if ('dsld_id' in item) return { kind: 'dsld', dsld_id: item.dsld_id, spd: item.servings_per_day };
  if ('ingredients' in item) return { kind: 'custom', item };

  if ('query' in item) {
    const r = await resolveQuery(dsld, item.query, item.brand, opts);
    const input = item.brand ? { query: item.query, brand: item.brand } : { query: item.query };
    const c = r.chosen;
    resolutions.push({
      input_path: path,
      input,
      status: c ? 'resolved' : 'not_found',
      matched_by: 'query',
      dsld_id: c?.dsld_id ?? null,
      product_ref: c ? `dsld:${c.dsld_id}` : null,
      brand: c?.brand ?? null,
      name: c?.name ?? null,
      entry_date: c?.entry_date ?? null,
      confidence: r.confidence,
      reason: r.reason,
      other_versions: c?.other_versions ?? [],
      alternatives: r.alternatives.map(({ other_versions: _ignored, ...alt }) => alt),
    });
    return c ? { kind: 'dsld', dsld_id: c.dsld_id, spd: item.servings_per_day } : { kind: 'none', label: item.query };
  }

  try {
    const m = await lookupUpc(dsld, item.upc, opts, `${path}.upc`);
    const v = m.versions[0]!;
    resolutions.push({
      input_path: path,
      input: { upc: m.upc },
      status: 'resolved',
      matched_by: 'upc',
      dsld_id: v.id,
      product_ref: `dsld:${v.id}`,
      brand: v.brand,
      name: v.name,
      entry_date: v.entry_date,
      confidence: 'high',
      reason: m.versions.length > 1 ? `barcode matches ${m.versions.length} label versions; using the newest` : 'barcode matches this label',
      other_versions: m.versions.slice(1).map((x) => x.id),
      alternatives: [],
    });
    return { kind: 'dsld', dsld_id: v.id, spd: item.servings_per_day };
  } catch (err) {
    if (!(err instanceof AppError) || err.code !== 'NOT_FOUND') throw err;
    resolutions.push({
      input_path: path,
      input: { upc: item.upc },
      status: 'not_found',
      matched_by: 'upc',
      dsld_id: null,
      product_ref: null,
      brand: null,
      name: null,
      entry_date: null,
      confidence: null,
      reason: err.message,
      other_versions: [],
      alternatives: [],
    });
    return { kind: 'none', label: `UPC ${item.upc}` };
  }
}

export async function analyze(body: unknown, deps: Deps) {
  const req = parseBody(analyzeRequest, body);
  assertSupportedProfile(req);
  const signal = upstreamBudget(deps);
  const opts = { signal };

  // 1. Resolve names and barcodes to DSLD IDs (in parallel).
  const resolutions: Resolution[] = [];
  const all = [...req.products.map((p, i) => ({ p, path: `products.${i}` })), ...(req.candidates ?? []).map((p, i) => ({ p, path: `candidates.${i}` }))];
  const medsPromise: Promise<MedicationMatch[]> = req.medications ? matchMedications(req.medications, deps.rxnorm ?? null, signal) : Promise.resolve([]);
  const resolved = await Promise.all(all.map(({ p, path }) => resolveItem(p, path, deps.dsld, opts, resolutions)));
  resolutions.sort((a, b) => all.findIndex((x) => x.path === a.input_path) - all.findIndex((x) => x.path === b.input_path));
  const base = resolved.slice(0, req.products.length);
  const cands = resolved.slice(req.products.length);
  if (base.every((r) => r.kind === 'none')) {
    throw new AppError('NOT_FOUND', 'None of the products could be identified in DSLD. Try a dsld_id from /v1/products/search, or a custom product.', { field: 'products' });
  }

  // 2. Fetch each distinct DSLD label once (shared concurrency limit in the client).
  const ids = [...new Set(resolved.flatMap((r) => (r.kind === 'dsld' ? [r.dsld_id] : [])))];
  const fetched = new Map<number, LabelResult>(
    await Promise.all(
      ids.map(async (id) => {
        try {
          return [id, await deps.dsld.getLabel(id, opts)] as const;
        } catch (err) {
          if (err instanceof AppError && err.code === 'NOT_FOUND') {
            const index = resolved.findIndex((r) => r.kind === 'dsld' && r.dsld_id === id);
            throw new AppError('NOT_FOUND', err.message, { field: `${all[index]!.path}.dsld_id` });
          }
          throw err;
        }
      }),
    ),
  );

  // 3. Normalize into stack products with unique refs.
  const seenRefs = new Map<string, number>();
  const uniqueRef = (ref: string) => {
    const n = (seenRefs.get(ref) ?? 0) + 1;
    seenRefs.set(ref, n);
    return n === 1 ? ref : `${ref}#${n}`;
  };
  let customCount = 0;
  const toStackProduct = (r: Resolved): StackProduct | null => {
    if (r.kind === 'none') return null;
    if (r.kind === 'dsld') {
      const { label, retrieved } = fetched.get(r.dsld_id)!;
      const normalized = normalizeDsldLabel(label);
      normalized.product_ref = uniqueRef(normalized.product_ref);
      for (const g of normalized.data_gaps) g.product_ref = normalized.product_ref;
      return { label: normalized, servings_per_day: r.spd, retrieved };
    }
    customCount++;
    const ref = uniqueRef(`custom:${customCount}`);
    return {
      label: normalizeCustomProduct(ref, r.item.name ?? `Custom product ${customCount}`, r.item.ingredients),
      servings_per_day: r.item.servings_per_day,
    };
  };
  const baseProducts = base.map(toStackProduct).filter((p): p is StackProduct => p !== null);
  const candProducts = cands.map(toStackProduct);

  // Point resolutions at the refs actually used (a repeated product gets dsld:ID#2).
  let cursor = 0;
  for (const [i, r] of resolved.entries()) {
    if (r.kind === 'none') continue;
    const sp = i < base.length ? baseProducts[cursor++] : candProducts[i - base.length];
    const res = resolutions.find((x) => x.input_path === all[i]!.path);
    if (res && sp) res.product_ref = sp.label.product_ref;
  }

  // 4. Analyze the stack, then each candidate added to it.
  const profile: Profile | null = req.age !== undefined && req.sex !== undefined ? { age: req.age, sex: req.sex, life_stage: req.life_stage ?? null } : null;
  const analysis = analyzeStack(baseProducts, profile);
  const unresolvedGaps: DataGap[] = resolutions
    .filter((r) => r.status === 'not_found')
    .map((r) => ({ code: 'PRODUCT_NOT_RESOLVED', detail: `${r.input_path}: ${'query' in r.input ? `"${r.input.query}"` : `UPC ${r.input.upc}`} could not be identified in DSLD and is not counted. ${r.reason}.` }));
  analysis.data_gaps.unshift(...unresolvedGaps);
  analysis.summary.data_gaps += unresolvedGaps.length;

  const candidateResults: CandidateResult[] = [];
  const extraSources: Source[] = [];
  for (const cp of candProducts) {
    if (!cp) continue;
    const combined: StackAnalysis = analyzeStack([...baseProducts, cp], profile);
    const summary = combined.products.find((p) => p.product_ref === cp.label.product_ref)!;
    candidateResults.push(compareCandidate(analysis, combined, summary));
    extraSources.push(...combined.sources);
  }

  // Optional food estimate, applied to the base stack only.
  let dietApplied = 0;
  if (req.diet === 'typical') {
    const d = applyTypicalDiet(analysis);
    dietApplied = d.applied;
    if (d.note) analysis.assumptions.push(d.note);
    if (d.applied) extraSources.push({ name: DIET_SOURCE.name, url: DIET_SOURCE.url, retrieved: DIET_SOURCE.retrieved });
  }
  const dietFlags = dietOnlyFlags(analysis).map(({ t, est }) => ({ name: t.name, percent_of_ul: est.percent_of_ul, flag: est.flags[0]! }));

  // Medication and condition interactions (NIH ODS fact sheets only).
  const meds = await medsPromise;
  const botanicals: BotanicalDetection[] = detectBotanicals(baseProducts, new Map(analysis.products.map((p) => [p.product_ref, p.servings_per_day_used])));
  for (const b of botanicals) extraSources.push({ name: b.source.name, url: b.source.url, retrieved: BOTANICALS_REVIEWED }, ...b.dose_findings.map((d) => ({ ...d.source, retrieved: BOTANICALS_REVIEWED })));
  const checked = Boolean(req.medications || req.conditions);
  const findings: InteractionFinding[] = checked ? evaluateInteractions(analysis, baseProducts, meds, req.conditions ?? [], botanicals) : [];
  if (req.medications) {
    const i = analysis.data_gaps.findIndex((g) => g.code === 'INTERACTIONS_NOT_ASSESSED');
    const unrec: DataGap[] = meds
      .filter((m) => m.status === 'not_recognized')
      .map((m) => ({ code: 'MEDICATION_NOT_RECOGNIZED', detail: `"${m.input}" did not match a medication class in the NIH fact sheet interaction list, so nothing was checked for it.` }));
    analysis.data_gaps.splice(i < 0 ? analysis.data_gaps.length : i, i < 0 ? 0 : 1, { code: 'INTERACTIONS_PARTIAL', detail: `${INTERACTIONS_SCOPE} Supplement-to-supplement interactions are not evaluated.` }, ...unrec);
    analysis.summary.data_gaps += unrec.length;
  }
  for (const f of findings) extraSources.push({ name: f.source.name, url: f.source.url, retrieved: INTERACTIONS_REVIEWED });
  const inStack = findings.filter((f) => f.in_stack);

  const suggestions = suggestFixes(analysis);
  const lowConfidence = resolutions
    .filter((r) => r.status === 'resolved' && r.confidence === 'low' && 'query' in r.input)
    .map((r) => ({ input: (r.input as { query: string }).query, chosen: [r.brand, r.name].filter(Boolean).join(' ') }));
  const text = agentSummary(analysis, {
    dietFlags,
    dietApplied: dietApplied > 0,
    suggestions,
    unresolved: resolutions.filter((r) => r.status === 'not_found').map((r) => ('query' in r.input ? r.input.query : `UPC ${r.input.upc}`)),
    lowConfidence,
    candidates: candidateResults,
    botanicals,
    pregnancyOrLactation: req.life_stage !== undefined,
    interactions: checked ? { findings: inStack, medicationsGiven: meds.length, unrecognized: meds.filter((m) => m.status === 'not_recognized').map((m) => m.input), conditionNames: (req.conditions ?? []).map(conditionName) } : undefined,
  });

  const { sources, products, summary, profile: prof, assumptions, nutrient_totals, overlaps, unrecognized_ingredients, data_gaps } = analysis;
  const fullSummary = {
    ...summary,
    products_unresolved: unresolvedGaps.length,
    suggestions: suggestions.length,
    ...(req.diet === 'typical' ? { diet_estimates: dietApplied, diet_only_flags: dietFlags.length } : {}),
    ...(checked ? { interaction_findings: findings.length, interaction_findings_in_stack: inStack.length } : {}),
    ...(botanicals.length ? { botanicals_with_signals: botanicals.length } : {}),
  };
  const allSources = dedupeSources([...sources, ...extraSources]);

  if (req.detail === 'summary') {
    // Compact form: only what an agent needs to answer, typically 1-3 KB.
    const flagged = nutrient_totals.filter((t) => t.flags.length || t.with_typical_diet?.flags.length);
    return envelope(
      {
        detail: 'summary',
        profile: prof,
        summary: fullSummary,
        agent_summary: text,
        ...(resolutions.length
          ? {
              resolutions: resolutions.map((r) => ({
                input_path: r.input_path,
                status: r.status,
                dsld_id: r.dsld_id,
                name: [r.brand, r.name].filter(Boolean).join(' ') || null,
                confidence: r.confidence,
                alternatives: r.alternatives.slice(0, 2).map((a) => ({ dsld_id: a.dsld_id, name: [a.brand, a.name].filter(Boolean).join(' ') })),
              })),
            }
          : {}),
        flagged: flagged.map((t) => ({
          nutrient_id: t.nutrient_id,
          name: t.name,
          amount_toward_ul: t.amount_toward_ul,
          ul: t.reference?.ul ?? null,
          percent_of_ul: t.percent_of_ul,
          flags: t.flags,
          severity: t.severity,
          ul_basis: t.reference?.ul_basis ?? null,
          ...(t.with_typical_diet ? { with_typical_diet: { percent_of_ul: t.with_typical_diet.percent_of_ul, flags: t.with_typical_diet.flags } } : {}),
        })),
        suggestions: suggestions.map((s) => ({ nutrient_id: s.nutrient_id, action: s.action, product_ref: s.product_ref, resolves: s.resolves, text: s.text })),
        ...(req.candidates ? { candidate_results: candidateResults.map((c) => ({ product_ref: c.product_ref, verdict: c.verdict, text: c.text })) } : {}),
        ...(botanicals.length
          ? { botanicals: botanicals.map((b) => ({ id: b.id, name: b.name, product_refs: b.product_refs, signal: (b.signals.find((s) => s.relay !== false) ?? b.signals[0])?.summary ?? null, ...(b.dose_findings.length ? { dose: b.dose_findings[0]!.summary } : {}) })) }
          : {}),
        ...(checked
          ? {
              interactions: {
                medications: meds.map((m) => ({ input: m.input, status: m.status, matched_name: m.matched_name })),
                // In-stack findings in full; the rest (nutrients the stack does not supply) as a count.
                findings: inStack.map((f) => ({ trigger: f.trigger, trigger_name: f.trigger_name, nutrient_ids: f.nutrient_ids, botanical_ids: f.botanical_ids, product_refs: f.product_refs, kind: f.kind, summary: f.summary, timing: f.timing })),
                not_in_stack: findings.length - inStack.length,
              },
            }
          : {}),
        data_gap_codes: [...new Set(data_gaps.map((g) => g.code))],
        provenance: provenanceShort(),
      },
      allSources.slice(0, 8),
    );
  }

  // Short fields first (gateways and agents read the start); large arrays last.
  return envelope(
    {
      profile: prof,
      summary: fullSummary,
      agent_summary: text,
      ...(resolutions.length ? { resolutions } : {}),
      assumptions,
      suggestions,
      ...(req.candidates ? { candidate_results: candidateResults } : {}),
      ...(botanicals.length ? { botanicals } : {}),
      ...(checked ? { interactions: { scope: INTERACTIONS_SCOPE, reviewed: INTERACTIONS_REVIEWED, medications: meds, findings } } : {}),
      nutrient_totals,
      overlaps,
      unrecognized_ingredients,
      data_gaps,
      products,
      provenance: provenanceShort(),
    },
    allSources,
  );
}

export function registerStackRoutes(app: FastifyInstance, deps: Deps): void {
  app.post('/v1/stack/analyze', async (req) => analyze(req.body, deps));
}
