import type { FastifyInstance } from 'fastify';
import { lookupReference } from '../lib/dri.js';
import { AppError } from '../lib/errors.js';
import { envelope, factsheetSource } from '../lib/envelope.js';
import { nutrientIndex } from '../lib/nutrients.js';
import { assertSupportedAge, parseBody, referenceRequest } from '../schemas/requests.js';

/** Offline and deterministic: the card's functional health check. */
export function nutrientReference(body: unknown) {
  const req = parseBody(referenceRequest, body);
  assertSupportedAge(req.age);
  const n = nutrientIndex.resolve(req.nutrient);
  if (!n) throw new AppError('NOT_FOUND', `Unknown nutrient "${req.nutrient}"`, { field: 'nutrient' });

  const ref = lookupReference(n, req.age, req.sex);
  return envelope(
    {
      nutrient: { id: n.id, name: n.name, unit: n.canonical_unit },
      profile: { age: req.age, sex: req.sex },
      reference: { ...ref, ul_unit: n.ul_unit, ul_scope: n.ul_scope, ul_note: n.ul_note, ul_basis: ref.ul !== null ? n.ul_basis : null },
      has_dri: n.dri !== null,
      factsheet_url: n.factsheet_url,
    },
    [factsheetSource(n.name, n.source_url, nutrientIndex.driReviewed)],
  );
}

export function registerNutrientRoutes(app: FastifyInstance): void {
  app.post('/v1/nutrients/reference', async (req) => nutrientReference(req.body));
}
