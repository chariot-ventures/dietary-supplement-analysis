import type { FastifyInstance } from 'fastify';
import { AppError } from '../lib/errors.js';
import { dsldSource, envelope } from '../lib/envelope.js';
import { normalizeDsldLabel, type NormalizedLabel } from '../lib/label.js';
import { getRequest, parseBody, searchRequest } from '../schemas/requests.js';
import { upstreamBudget, type Deps } from './deps.js';

/** Product summary for search results: small, no ingredient detail. */
function summarize(l: NormalizedLabel) {
  return {
    dsld_id: l.dsld_id,
    brand: l.brand,
    name: l.name,
    upc: l.upc,
    on_market: l.on_market,
    serving: l.serving,
    ingredient_count: l.ingredient_count,
    nutrient_ids: [...new Set(l.ingredients.map((i) => i.nutrient_id))],
    source_url: l.source_url,
  };
}

/** Full normalized label with short fields first and large arrays last. */
export function serializeLabel(l: NormalizedLabel) {
  return {
    dsld_id: l.dsld_id,
    brand: l.brand,
    name: l.name,
    upc: l.upc,
    on_market: l.on_market,
    serving: l.serving,
    ingredient_count: l.ingredient_count,
    source_url: l.source_url,
    ingredients: l.ingredients,
    unrecognized_ingredients: l.unrecognized_ingredients,
    data_gaps: l.data_gaps,
    statements: l.statements,
  };
}

export async function searchProducts(body: unknown, deps: Deps) {
  const req = parseBody(searchRequest, body);
  const signal = upstreamBudget(deps);
  const result = await deps.dsld.search({
    query: req.query,
    brand: req.brand,
    ingredient: req.ingredient,
    onMarketOnly: req.on_market_only,
    size: req.limit,
  }, { signal });
  const ids = result.ids.slice(0, req.limit);
  const settled = await Promise.allSettled(ids.map((id) => deps.dsld.getLabel(id, { signal })));
  const labels = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
  const upstream = settled.find((s) => s.status === 'rejected' && s.reason instanceof AppError && s.reason.code === 'UPSTREAM_UNAVAILABLE');
  if (ids.length && labels.length === 0 && upstream) throw (upstream as PromiseRejectedResult).reason;

  const products = labels.map((l) => summarize(normalizeDsldLabel(l.label)));
  const sources = [
    dsldSource('https://api.ods.od.nih.gov/dsld/v9/search-filter', result.retrieved),
    ...labels.map((l) => dsldSource(`https://dsld.od.nih.gov/label/${l.label.id}`, l.retrieved)),
  ];
  return envelope(
    {
      query: { query: req.query ?? null, brand: req.brand ?? null, ingredient: req.ingredient ?? null, on_market_only: req.on_market_only, limit: req.limit },
      total_hits: result.total,
      returned: products.length,
      products,
    },
    sources,
  );
}

export async function getProducts(body: unknown, deps: Deps) {
  const req = parseBody(getRequest, body);
  const ids = req.dsld_ids ?? [req.dsld_id!];
  const unique = [...new Set(ids)];
  const signal = upstreamBudget(deps);
  const labels = await Promise.all(
    unique.map((id) =>
      deps.dsld.getLabel(id, { signal }).catch((err: unknown) => {
        if (err instanceof AppError && err.code === 'NOT_FOUND') {
          throw new AppError('NOT_FOUND', err.message, { field: req.dsld_ids ? `dsld_ids.${ids.indexOf(id)}` : 'dsld_id' });
        }
        throw err;
      }),
    ),
  );
  const products = labels.map((l) => serializeLabel(normalizeDsldLabel(l.label)));
  return envelope(
    { requested: unique.length, returned: products.length, products },
    labels.map((l) => dsldSource(`https://dsld.od.nih.gov/label/${l.label.id}`, l.retrieved)),
  );
}

export function registerProductRoutes(app: FastifyInstance, deps: Deps): void {
  app.post('/v1/products/search', async (req) => searchProducts(req.body, deps));
  app.post('/v1/products/get', async (req) => getProducts(req.body, deps));
}
