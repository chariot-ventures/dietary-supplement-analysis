import type { FastifyInstance } from 'fastify';
import { analyzeStack, type StackProduct } from '../lib/analyze.js';
import { AppError } from '../lib/errors.js';
import { envelope } from '../lib/envelope.js';
import { normalizeCustomProduct, normalizeDsldLabel } from '../lib/label.js';
import { analyzeRequest, assertSupportedAge, parseBody } from '../schemas/requests.js';
import type { Deps } from './deps.js';

export async function analyze(body: unknown, deps: Deps) {
  const req = parseBody(analyzeRequest, body);
  assertSupportedAge(req.age);

  // Fetch each distinct DSLD label once (shared concurrency limit in the client).
  const ids = [...new Set(req.products.flatMap((p) => ('dsld_id' in p ? [p.dsld_id] : [])))];
  const fetched = new Map(
    await Promise.all(
      ids.map(async (id) => {
        try {
          return [id, await deps.dsld.getLabel(id)] as const;
        } catch (err) {
          if (err instanceof AppError && err.code === 'NOT_FOUND') {
            const index = req.products.findIndex((p) => 'dsld_id' in p && p.dsld_id === id);
            throw new AppError('NOT_FOUND', err.message, { field: `products.${index}.dsld_id` });
          }
          throw err;
        }
      }),
    ),
  );

  const seenRefs = new Map<string, number>();
  const uniqueRef = (ref: string) => {
    const n = (seenRefs.get(ref) ?? 0) + 1;
    seenRefs.set(ref, n);
    return n === 1 ? ref : `${ref}#${n}`;
  };

  let customCount = 0;
  const products: StackProduct[] = req.products.map((p) => {
    if ('dsld_id' in p) {
      const { label, retrieved } = fetched.get(p.dsld_id)!;
      const normalized = normalizeDsldLabel(label);
      normalized.product_ref = uniqueRef(normalized.product_ref);
      for (const g of normalized.data_gaps) g.product_ref = normalized.product_ref;
      return { label: normalized, servings_per_day: p.servings_per_day, retrieved };
    }
    customCount++;
    const ref = uniqueRef(`custom:${customCount}`);
    return { label: normalizeCustomProduct(ref, p.name ?? `Custom product ${customCount}`, p.ingredients), servings_per_day: p.servings_per_day };
  });

  const profile = req.age !== undefined && req.sex !== undefined ? { age: req.age, sex: req.sex } : null;
  const { sources, ...result } = analyzeStack(products, profile);
  const { products: productSummaries, ...rest } = result;
  // Large arrays last; products after data_gaps as documented.
  return envelope({ ...rest, products: productSummaries }, sources);
}

export function registerStackRoutes(app: FastifyInstance, deps: Deps): void {
  app.post('/v1/stack/analyze', async (req) => analyze(req.body, deps));
}
