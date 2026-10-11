import { z } from 'zod';
import { AppError } from '../lib/errors.js';

export const MAX_STACK_PRODUCTS = 15;
export const MAX_GET_IDS = 10;
export const MAX_SEARCH_LIMIT = 10;

const dsldId = z.number().int().positive().max(10_000_000).describe('DSLD label ID, e.g. from /v1/products/search');
const sex = z.enum(['male', 'female']);
const age = z.number().min(0).max(120).describe('Age in years. Ages under 1 are not supported in v1.');
const servingsPerDay = z
  .number()
  .positive()
  .max(50)
  .describe('Servings taken per day. Default: the label maximum daily servings, else 1.');

export const searchRequest = z
  .object({
    query: z.string().trim().min(1).max(200).optional().describe('Free-text search, e.g. "vitamin d3 5000"'),
    brand: z.string().trim().min(1).max(100).optional(),
    ingredient: z.string().trim().min(1).max(100).optional().describe('Ingredient name, e.g. "cholecalciferol"'),
    on_market_only: z.boolean().default(true),
    limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).default(5),
  })
  .refine((v) => v.query || v.brand || v.ingredient, { message: 'Give at least one of query, brand or ingredient', path: ['query'] });

export const getRequest = z
  .object({
    dsld_id: dsldId.optional(),
    dsld_ids: z.array(dsldId).min(1).max(MAX_GET_IDS).optional(),
  })
  .refine((v) => (v.dsld_id === undefined) !== (v.dsld_ids === undefined), {
    message: `Give exactly one of dsld_id or dsld_ids (max ${MAX_GET_IDS})`,
    path: ['dsld_id'],
  });

export const referenceRequest = z.object({
  nutrient: z.string().trim().min(1).max(100).describe('Nutrient ID ("vitamin-d") or any synonym ("cholecalciferol")'),
  age,
  sex,
});

export const customIngredient = z.object({
  name: z.string().trim().min(1).max(200),
  amount: z.number().nonnegative().max(10_000_000),
  unit: z.string().trim().min(1).max(30).describe('mg, mcg, g, IU, mcg DFE, mcg RAE, mg NE'),
  form: z.string().trim().min(1).max(200).optional().describe('Declared form, e.g. "folic acid", "retinyl palmitate", "d-alpha tocopherol"'),
  nutrient_basis: z
    .enum(['elemental', 'compound'])
    .optional()
    .describe('For minerals: whether amount is elemental or the whole compound weight'),
});

export const dsldProduct = z.object({ dsld_id: dsldId, servings_per_day: servingsPerDay.optional() }).strict();
export const customProduct = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    servings_per_day: servingsPerDay.optional(),
    ingredients: z.array(customIngredient).min(1).max(50),
  })
  .strict();

export const analyzeRequest = z
  .object({
    age: age.optional(),
    sex: sex.optional(),
    products: z
      .array(z.union([dsldProduct, customProduct]))
      .min(1)
      .max(MAX_STACK_PRODUCTS)
      .describe(`1-${MAX_STACK_PRODUCTS} products: each a DSLD ID or a custom product with explicit ingredients`),
  })
  .refine((v) => (v.age === undefined) === (v.sex === undefined), { message: 'Give age and sex together, or neither', path: ['age'] });

export const toolRequest = z.object({
  tool: z.enum(['products_search', 'products_get', 'nutrients_reference', 'stack_analyze']),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

export type SearchRequest = z.infer<typeof searchRequest>;
export type GetRequest = z.infer<typeof getRequest>;
export type ReferenceRequest = z.infer<typeof referenceRequest>;
export type AnalyzeRequest = z.infer<typeof analyzeRequest>;

const UNSUPPORTED_PROFILE_FIELDS = ['pregnant', 'pregnancy', 'lactating', 'lactation', 'breastfeeding', 'life_stage'];

/** Parse a request body or throw a 400 INVALID_INPUT naming the first offending field. */
export function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError('INVALID_INPUT', 'Request body must be a JSON object', { field: 'body' });
  }
  for (const key of UNSUPPORTED_PROFILE_FIELDS) {
    if (key in body && (body as Record<string, unknown>)[key] !== undefined && (body as Record<string, unknown>)[key] !== false) {
      throw new AppError('UNSUPPORTED', 'Pregnancy and lactation reference values are not supported in v1', { field: key });
    }
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    const field = issue.path.length ? issue.path.join('.') : 'body';
    throw new AppError('INVALID_INPUT', `${field}: ${issue.message}`, { field });
  }
  return result.data;
}

/** Infant reference values are out of scope; give agents a stable code for it. */
export function assertSupportedAge(age: number | undefined): void {
  if (age !== undefined && age < 1) {
    throw new AppError('UNSUPPORTED', 'Reference values for infants under 1 year are not supported in v1', { field: 'age' });
  }
}
