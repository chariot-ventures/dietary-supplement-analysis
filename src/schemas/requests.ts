import { z } from 'zod';
import { AppError } from '../lib/errors.js';

export const MAX_STACK_PRODUCTS = 15;
export const MAX_GET_IDS = 10;
export const MAX_SEARCH_LIMIT = 10;
export const MAX_CANDIDATES = 5;

const dsldId = z.number().int().positive().max(10_000_000).describe('DSLD label ID, e.g. from /v1/products/search');
const sex = z.enum(['male', 'female']);
const age = z.number().min(0).max(120).describe('Age in years. For infants use a fraction: 0.25 = 3 months; 0-5 and 6-11 month values apply under 1.');
const lifeStage = z
  .enum(['pregnancy', 'lactation'])
  .describe('Pregnancy or lactation (breastfeeding) reference values; requires sex "female" and age 14-50');
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
    dedupe_versions: z
      .boolean()
      .default(true)
      .describe('Collapse label versions of the same product (same brand and name) into one result, newest first; older IDs are listed in other_versions'),
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

const upc = z
  .string()
  .trim()
  .min(8)
  .max(32)
  .describe('UPC-A or EAN barcode digits as printed on the bottle, e.g. "031604026974" (spaces and dashes are ignored)');

export const lookupRequest = z.object({ upc }).strict();

export const referenceRequest = z.object({
  nutrient: z.string().trim().min(1).max(100).describe('Nutrient ID ("vitamin-d") or any synonym ("cholecalciferol")'),
  age,
  sex,
  life_stage: lifeStage.optional(),
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
export const queryProduct = z
  .object({
    query: z.string().trim().min(2).max(200).describe('Product as the user named it, e.g. "Centrum Silver Women 50+". Resolved to the best-matching DSLD label; see resolutions[]'),
    brand: z.string().trim().min(1).max(100).optional().describe('Brand, if known separately'),
    servings_per_day: servingsPerDay.optional(),
  })
  .strict();
export const upcProduct = z.object({ upc, servings_per_day: servingsPerDay.optional() }).strict();
export const customProduct = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    servings_per_day: servingsPerDay.optional(),
    ingredients: z.array(customIngredient).min(1).max(50),
  })
  .strict();

export const stackProduct = z.union([dsldProduct, queryProduct, upcProduct, customProduct]);

export const analyzeRequest = z
  .object({
    age: age.optional(),
    sex: sex.optional(),
    life_stage: lifeStage.optional(),
    diet: z
      .enum(['none', 'typical'])
      .default('none')
      .describe('"typical" adds the US average intake from food and drinks for this age and sex (NHANES) to estimate total intake; see with_typical_diet'),
    products: z
      .array(stackProduct)
      .min(1)
      .max(MAX_STACK_PRODUCTS)
      .describe(
        `1-${MAX_STACK_PRODUCTS} products. Each is one of: {"dsld_id"}, {"query"} (a product name, resolved server-side), {"upc"} (barcode), or a custom product {"name","ingredients"}. Add "servings_per_day" to any of them.`,
      ),
    candidates: z
      .array(stackProduct)
      .min(1)
      .max(MAX_CANDIDATES)
      .optional()
      .describe(`Optional, up to ${MAX_CANDIDATES}: products the user is considering adding. Each is evaluated as an addition to the stack in candidate_results[]; they are not included in nutrient_totals.`),
  })
  .refine((v) => (v.age === undefined) === (v.sex === undefined), { message: 'Give age and sex together, or neither', path: ['age'] });

export const toolRequest = z.object({
  tool: z.enum(['products_search', 'products_get', 'products_lookup', 'nutrients_reference', 'stack_analyze']),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

export type SearchRequest = z.infer<typeof searchRequest>;
export type GetRequest = z.infer<typeof getRequest>;
export type ReferenceRequest = z.infer<typeof referenceRequest>;
export type AnalyzeRequest = z.infer<typeof analyzeRequest>;
export type StackProductInput = z.infer<typeof stackProduct>;
export type LookupRequest = z.infer<typeof lookupRequest>;

/** Booleans some callers send instead of life_stage. */
const LIFE_STAGE_ALIASES: Record<string, 'pregnancy' | 'lactation'> = {
  pregnant: 'pregnancy',
  pregnancy: 'pregnancy',
  lactating: 'lactation',
  lactation: 'lactation',
  breastfeeding: 'lactation',
};

/** Parse a request body or throw a 400 INVALID_INPUT naming the first offending field. */
export function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError('INVALID_INPUT', 'Request body must be a JSON object', { field: 'body' });
  }
  const input = { ...(body as Record<string, unknown>) };
  for (const [key, stage] of Object.entries(LIFE_STAGE_ALIASES)) {
    if (input[key] === true && input.life_stage === undefined) input.life_stage = stage;
    if (typeof input[key] === 'boolean') delete input[key];
  }
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    const field = issue.path.length ? issue.path.join('.') : 'body';
    throw new AppError('INVALID_INPUT', `${field}: ${issue.message}`, { field });
  }
  return result.data;
}

/** Pregnancy and lactation values exist for females aged 14-50 only. */
export function assertSupportedProfile(p: { age?: number | undefined; sex?: string | undefined; life_stage?: string | undefined }): void {
  if (!p.life_stage) return;
  if (p.sex !== 'female') throw new AppError('INVALID_INPUT', `life_stage "${p.life_stage}" requires sex "female"`, { field: 'life_stage' });
  if (p.age === undefined || p.age < 14 || p.age >= 51) {
    throw new AppError('UNSUPPORTED', `${p.life_stage === 'pregnancy' ? 'Pregnancy' : 'Lactation'} reference values are published for ages 14-50 only`, { field: 'age' });
  }
}
