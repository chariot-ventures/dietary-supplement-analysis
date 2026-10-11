import type { FastifyInstance } from 'fastify';
import { dedupeSources, envelope } from '../lib/envelope.js';
import { AppError } from '../lib/errors.js';
import { INTERACTIONS_REVIEWED, listInteractions, matchMedications } from '../lib/interactions.js';
import { matchBotanical } from '../lib/botanicals.js';
import { nutrientIndex } from '../lib/nutrients.js';
import { provenanceShort } from '../lib/provenance.js';
import { interactionsRequest, parseBody } from '../schemas/requests.js';
import { upstreamBudget, type Deps } from './deps.js';

export const INTERACTIONS_SCOPE =
  'Only interactions named in NIH fact sheets (Office of Dietary Supplements and NCCIH) are checked. The list is not exhaustive: a medication with no findings may still interact. A pharmacist can check the full list.';

/** Medication and condition interactions without a stack: what NIH lists, per nutrient. */
export async function checkInteractions(body: unknown, deps: Deps) {
  const req = parseBody(interactionsRequest, body);
  let nutrientIds: string[] | null = null;
  if (req.nutrients) {
    nutrientIds = req.nutrients.map((q, i) => {
      const id = nutrientIndex.resolve(q)?.id ?? matchBotanical([q])?.id;
      if (!id) throw new AppError('NOT_FOUND', `Unknown nutrient or botanical "${q}"`, { field: `nutrients.${i}` });
      return id;
    });
  }
  const meds = await matchMedications(req.medications ?? [], deps.rxnorm ?? null, upstreamBudget(deps));
  const findings = listInteractions(meds, req.conditions ?? [], nutrientIds);
  const unrecognized = meds.filter((m) => m.status === 'not_recognized').map((m) => m.input);
  return envelope(
    {
      summary: { medications: meds.length, medications_recognized: meds.length - unrecognized.length, findings: findings.length },
      scope: INTERACTIONS_SCOPE,
      reviewed: INTERACTIONS_REVIEWED,
      medications: meds,
      findings,
      ...(unrecognized.length
        ? { data_gaps: unrecognized.map((u) => ({ code: 'MEDICATION_NOT_RECOGNIZED', detail: `"${u}" did not match a medication class in the NIH fact sheet interaction list, so nothing was checked for it.` })) }
        : {}),
      provenance: provenanceShort(),
    },
    dedupeSources(findings.map((f) => ({ name: f.source.name, url: f.source.url, retrieved: INTERACTIONS_REVIEWED }))),
  );
}

export function registerInteractionRoutes(app: FastifyInstance, deps: Deps): void {
  app.post('/v1/interactions/check', async (req) => checkInteractions(req.body, deps));
}
