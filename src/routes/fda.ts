import type { FastifyInstance } from 'fastify';
import { lookupUpc, resolveQuery } from '../lib/catalog.js';
import { dsldLabelUrl, normalizeUpc } from '../lib/dsld.js';
import { envelope, type Source } from '../lib/envelope.js';
import { AppError } from '../lib/errors.js';
import { CAERS_DISCLAIMER, type FdaReport, type ProductKey } from '../lib/openfda.js';
import { provenanceShort } from '../lib/provenance.js';
import { todayIso } from '../lib/text.js';
import { fdaRequest, parseBody } from '../schemas/requests.js';
import { upstreamBudget, type Deps } from './deps.js';

const num = (n: number) => n.toLocaleString('en-US');

export function fdaSummary(p: ProductKey, r: FdaReport): string {
  const parts: string[] = [];
  const who = `${p.brand} ${p.name}`.trim();
  if (r.unavailable.includes('recalls')) parts.push('FDA recall data could not be reached.');
  else if (r.recalls.matched.length) {
    const latest = r.recalls.matched[0]!;
    parts.push(
      `FDA lists ${r.recalls.matched.length} recall${r.recalls.matched.length === 1 ? '' : 's'} matching ${who}; the latest (${[latest.classification, latest.recall_initiation_date?.slice(0, 4), latest.status?.toLowerCase()].filter(Boolean).join(', ')}): ${latest.reason_for_recall ?? 'reason not given'}`,
    );
  } else {
    parts.push(`No FDA recall matches ${who} by barcode or by brand and product name${r.recalls.brand_recalls_total ? ` (${num(r.recalls.brand_recalls_total)} recall record${r.recalls.brand_recalls_total === 1 ? '' : 's'} mention the brand)` : ''}.`);
  }
  const ae = r.adverse_events;
  if (r.unavailable.includes('adverse_events')) parts.push('FDA adverse event data could not be reached.');
  else if (ae.scope === 'product') parts.push(`${num(ae.total)} FDA adverse event report${ae.total === 1 ? '' : 's'} name a product matching it${ae.top_reactions.length ? ` (most often: ${ae.top_reactions.slice(0, 3).map((t) => t.term).join(', ')})` : ''}.`);
  else if (ae.scope === 'brand') parts.push(`No FDA adverse event report names this product; ${num(ae.total)} name ${p.brand} products.`);
  else parts.push('No FDA adverse event report names this brand.');
  if (ae.total) parts.push(CAERS_DISCLAIMER);
  return parts.join(' ');
}

/** FDA recalls and adverse event reports for one product (openFDA). */
export async function fdaReports(body: unknown, deps: Deps) {
  const req = parseBody(fdaRequest, body);
  if (!deps.openfda) throw new AppError('UNSUPPORTED', 'FDA lookups are turned off on this supplier', { field: 'body' });
  const signal = upstreamBudget(deps);
  const opts = { signal };

  let key: ProductKey;
  let dsldId: number | null = null;
  if (req.dsld_id !== undefined || req.upc !== undefined || req.query !== undefined) {
    if (req.upc !== undefined) dsldId = (await lookupUpc(deps.dsld, req.upc, opts)).versions[0]!.id;
    else if (req.query !== undefined) {
      const r = await resolveQuery(deps.dsld, req.query, req.brand, opts);
      if (!r.chosen) throw new AppError('NOT_FOUND', `"${req.query}" could not be identified in DSLD. Give brand and name instead.`, { field: 'query' });
      dsldId = r.chosen.dsld_id;
    } else dsldId = req.dsld_id!;
    const { label } = await deps.dsld.getLabel(dsldId, opts);
    const upc = label.upcSku ? normalizeUpc(label.upcSku) : req.upc ? normalizeUpc(req.upc) : null;
    key = { brand: label.brandName ?? req.brand ?? '', name: label.fullName ?? '', upc: upc && upc.length === 12 ? upc : null };
    if (!key.brand) throw new AppError('UNSUPPORTED', 'The DSLD label has no brand, which FDA records are searched by', { field: 'dsld_id' });
  } else {
    key = { brand: req.brand!, name: req.name!, upc: null };
  }

  const report = await deps.openfda.report(key, signal);
  const today = todayIso();
  const sources: Source[] = [
    { name: 'openFDA food enforcement reports (recalls)', url: report.recalls.search_url, retrieved: today },
    { name: 'openFDA CAERS adverse event reports', url: report.adverse_events.search_url, retrieved: today },
    ...(dsldId ? [{ name: 'NIH Dietary Supplement Label Database', url: dsldLabelUrl(dsldId), retrieved: today }] : []),
  ];
  return envelope(
    {
      product: { dsld_id: dsldId, brand: key.brand, name: key.name, upc: key.upc },
      agent_summary: fdaSummary(key, report),
      recalls: report.recalls,
      adverse_events: { ...report.adverse_events, note: CAERS_DISCLAIMER },
      ...(report.unavailable.length
        ? { data_gaps: report.unavailable.map((u) => ({ code: 'FDA_UNAVAILABLE', detail: `openFDA ${u === 'recalls' ? 'recall' : 'adverse event'} data could not be reached; retry later.` })) }
        : {}),
      provenance: provenanceShort(),
    },
    sources,
  );
}

export function registerFdaRoutes(app: FastifyInstance, deps: Deps): void {
  app.post('/v1/products/fda', async (req) => fdaReports(req.body, deps));
}
