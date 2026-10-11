/**
 * OpenAPI 3.1 document. Request schemas are generated from the Zod schemas the
 * routes validate with; response schemas are written out here. The committed
 * copy in openapi/openapi.json is produced by scripts/build-openapi.ts and a
 * test fails if it drifts from this function.
 */
import { z } from 'zod';
import { analyzeRequest, getRequest, referenceRequest, searchRequest, toolRequest } from './schemas/requests.js';
import { DOCS_URL, SERVICE_ID, VERSION } from './version.js';

type Json = Record<string, unknown>;

function requestSchema(schema: z.ZodType): Json {
  const out = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Json;
  delete out.$schema;
  return out;
}

const nullable = (type: string | string[]): Json => ({ type: [...(Array.isArray(type) ? type : [type]), 'null'] });
const amount: Json = { type: 'object', properties: { amount: { type: 'number' }, unit: { type: 'string' } }, required: ['amount', 'unit'] };
const nullableAmount: Json = { oneOf: [amount, { type: 'null' }] };

const common = {
  service: { type: 'string', const: SERVICE_ID },
  version: { type: 'string' },
  as_of: { type: 'string', format: 'date' },
};
const tail = {
  sources: { type: 'array', items: { $ref: '#/components/schemas/Source' } },
  disclaimer: { type: 'string' },
};

const components: Json = {
  Source: {
    type: 'object',
    properties: { name: { type: 'string' }, url: { type: 'string' }, retrieved: { type: 'string' } },
    required: ['name', 'url', 'retrieved'],
  },
  Error: {
    type: 'object',
    properties: {
      error: {
        type: 'object',
        properties: {
          code: { type: 'string', enum: ['INVALID_INPUT', 'NOT_FOUND', 'UNSUPPORTED', 'UPSTREAM_UNAVAILABLE', 'INTERNAL_ERROR'] },
          message: { type: 'string' },
          retryable: { type: 'boolean' },
          field: { type: 'string' },
        },
        required: ['code', 'message', 'retryable'],
      },
    },
    required: ['error'],
  },
  DataGap: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        enum: [
          'BLEND_UNQUANTIFIED',
          'QUANTITY_MISSING',
          'UNIT_NOT_CONVERTIBLE',
          'COMPOUND_WEIGHT',
          'AMBIGUOUS_BASIS',
          'UL_PARTIAL',
          'UL_NOT_ASSESSED',
          'NO_REFERENCE',
          'PROFILE_MISSING',
          'SERVINGS_UNKNOWN',
          'INTERACTIONS_NOT_ASSESSED',
        ],
      },
      product_ref: { type: 'string' },
      nutrient_id: { type: 'string' },
      detail: { type: 'string' },
    },
    required: ['code', 'detail'],
  },
  Serving: {
    type: 'object',
    properties: {
      quantity: nullable('number'),
      unit: nullable('string'),
      daily_servings: { type: 'object', properties: { min: nullable('number'), max: nullable('number') } },
      label_text: nullable('string'),
    },
  },
  Ingredient: {
    type: 'object',
    properties: {
      label_name: { type: 'string' },
      nutrient_id: { type: 'string' },
      nutrient_name: { type: 'string' },
      matched_by: { type: 'string', enum: ['ingredient_group', 'unii', 'name', 'form'] },
      forms: { type: 'array', items: { type: 'string' } },
      form_kind: nullable('string'),
      per_serving: { ...nullableAmount, description: 'Per serving in the nutrient canonical unit; null if missing or not convertible' },
      label_amount: { ...nullableAmount, description: 'As declared on the label' },
      conversion_note: nullable('string'),
      percent_dv: nullable('number'),
      in_blend: { type: 'boolean' },
      blend_name: { type: 'string' },
    },
  },
  UnrecognizedIngredient: {
    type: 'object',
    properties: {
      product_ref: { type: 'string' },
      label_name: { type: 'string' },
      category: nullable('string'),
      per_serving: nullableAmount,
      in_blend: { type: 'boolean' },
      is_blend: { type: 'boolean' },
    },
  },
  ProductSummary: {
    type: 'object',
    properties: {
      dsld_id: { type: 'integer' },
      brand: nullable('string'),
      name: { type: 'string' },
      upc: nullable('string'),
      on_market: nullable('boolean'),
      serving: { $ref: '#/components/schemas/Serving' },
      ingredient_count: { type: 'integer' },
      nutrient_ids: { type: 'array', items: { type: 'string' } },
      source_url: { type: 'string' },
    },
  },
  Label: {
    type: 'object',
    properties: {
      dsld_id: { type: 'integer' },
      brand: nullable('string'),
      name: { type: 'string' },
      upc: nullable('string'),
      on_market: nullable('boolean'),
      serving: { $ref: '#/components/schemas/Serving' },
      ingredient_count: { type: 'integer' },
      source_url: { type: 'string' },
      ingredients: { type: 'array', items: { $ref: '#/components/schemas/Ingredient' } },
      unrecognized_ingredients: { type: 'array', items: { $ref: '#/components/schemas/UnrecognizedIngredient' } },
      data_gaps: { type: 'array', items: { $ref: '#/components/schemas/DataGap' } },
      statements: { type: 'array', items: { type: 'object', properties: { type: { type: 'string' }, text: { type: 'string' } } } },
    },
  },
  Reference: {
    type: 'object',
    properties: {
      rda: nullable('number'),
      ear: nullable('number'),
      ai: nullable('number'),
      ul: nullable('number'),
      unit: { type: 'string' },
      ul_unit: nullable('string'),
      ul_scope: { type: 'string' },
      ul_note: nullable('string'),
    },
  },
  NutrientTotal: {
    type: 'object',
    properties: {
      nutrient_id: { type: 'string' },
      name: { type: 'string' },
      daily_total: amount,
      complete: { type: 'boolean', description: 'False when some label rows could not be counted; the total is then a lower bound' },
      reference: { oneOf: [{ $ref: '#/components/schemas/Reference' }, { type: 'null' }] },
      amount_toward_ul: { ...nullableAmount, description: 'The part of the total the UL applies to (e.g. folic acid, preformed vitamin A)' },
      percent_of_ul: nullable('number'),
      percent_of_rda: nullable('number'),
      percent_of_ai: nullable('number'),
      flags: { type: 'array', items: { type: 'string', enum: ['above_ul', 'below_reference'] } },
      factsheet_url: { type: 'string' },
      contributions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            product_ref: { type: 'string' },
            label_name: { type: 'string' },
            label_amount: nullable('string'),
            converted: amount,
            servings_per_day: { type: 'number' },
            daily: amount,
            daily_toward_ul: nullable('number'),
          },
        },
      },
    },
  },
};

function ok(description: string, properties: Json): Json {
  return {
    description,
    content: { 'application/json': { schema: { type: 'object', properties: { ...common, ...properties, ...tail } } } },
  };
}

const errorResponses = {
  '400': { description: 'INVALID_INPUT', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
  '404': { description: 'NOT_FOUND (unknown DSLD ID or nutrient)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
  '422': { description: 'UNSUPPORTED (e.g. pregnancy, infants)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
  '424': {
    description: 'UPSTREAM_UNAVAILABLE: NIH DSLD unreachable and nothing cached (retryable)',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
};

function post(summary: string, description: string, request: z.ZodType, response: Json): Json {
  return {
    post: {
      summary,
      description,
      requestBody: { required: true, content: { 'application/json': { schema: requestSchema(request) } } },
      responses: { '200': response, ...errorResponses },
    },
  };
}

export function buildOpenApi(): Json {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Dietary Supplement Label and Nutrient Intake Analysis',
      version: VERSION,
      description:
        'Look up dietary supplement labels from the NIH Dietary Supplement Label Database (DSLD) and total vitamin and mineral intake across a list of supplements, compared with NIH recommended amounts (RDA/AI) and upper limits (UL). Label and reference data only; not medical advice.',
    },
    externalDocs: { url: DOCS_URL },
    servers: [{ url: '/' }],
    paths: {
      '/': { get: { summary: 'Service identity', responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } } } } },
      '/v1/version': {
        get: {
          summary: 'Identity probe',
          responses: {
            '200': {
              description: 'OK',
              content: { 'application/json': { schema: { type: 'object', properties: { service: { const: SERVICE_ID }, version: { type: 'string' } }, required: ['service', 'version'] } } },
            },
          },
        },
      },
      '/v1/health': {
        get: {
          summary: 'Readiness',
          responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { status: { const: 'ok' } } } } } } },
        },
      },
      '/v1/products/search': post(
        'Search DSLD products',
        'Searches the NIH DSLD and returns up to `limit` (max 10) product summaries. On-market only by default.',
        searchRequest,
        ok('Search results', {
          query: { type: 'object' },
          total_hits: { type: 'integer' },
          returned: { type: 'integer' },
          products: { type: 'array', items: { $ref: '#/components/schemas/ProductSummary' } },
        }),
      ),
      '/v1/products/get': post(
        'Get normalized labels',
        'Normalized label(s) by DSLD ID (max 10). Original label amounts are kept next to converted amounts.',
        getRequest,
        ok('Labels', {
          requested: { type: 'integer' },
          returned: { type: 'integer' },
          products: { type: 'array', items: { $ref: '#/components/schemas/Label' } },
        }),
      ),
      '/v1/nutrients/reference': post(
        'Reference intakes for a nutrient',
        'RDA, EAR, AI and UL for one nutrient at an age and sex. Offline and deterministic.',
        referenceRequest,
        ok('Reference values', {
          nutrient: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, unit: { type: 'string' } } },
          profile: { type: 'object', properties: { age: { type: 'number' }, sex: { type: 'string' } } },
          reference: { $ref: '#/components/schemas/Reference' },
          has_dri: { type: 'boolean' },
          factsheet_url: { type: 'string' },
        }),
      ),
      '/v1/stack/analyze': post(
        'Analyze a supplement stack',
        'Per-nutrient daily totals across 1-15 products (DSLD IDs or custom ingredient lists), compared with reference intakes when age and sex are given. No flag means nothing to report, not a judgement about the stack.',
        analyzeRequest,
        ok('Stack analysis', {
          profile: { oneOf: [{ type: 'object', properties: { age: { type: 'number' }, sex: { type: 'string' } } }, { type: 'null' }] },
          summary: {
            type: 'object',
            properties: {
              products_matched: { type: 'integer' },
              nutrients_totaled: { type: 'integer' },
              above_ul: { type: 'integer' },
              below_reference: { type: 'integer' },
              data_gaps: { type: 'integer' },
            },
          },
          assumptions: { type: 'array', items: { type: 'string' } },
          nutrient_totals: { type: 'array', items: { $ref: '#/components/schemas/NutrientTotal' } },
          overlaps: {
            type: 'array',
            items: { type: 'object', properties: { nutrient_id: { type: 'string' }, product_refs: { type: 'array', items: { type: 'string' } } } },
          },
          unrecognized_ingredients: { type: 'array', items: { $ref: '#/components/schemas/UnrecognizedIngredient' } },
          data_gaps: { type: 'array', items: { $ref: '#/components/schemas/DataGap' } },
          products: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                product_ref: { type: 'string' },
                dsld_id: nullable('integer'),
                brand: nullable('string'),
                name: { type: 'string' },
                servings_per_day_used: { type: 'number' },
                servings_source: { type: 'string', enum: ['request', 'label_maximum', 'default'] },
                source_url: nullable('string'),
              },
            },
          },
        }),
      ),
      '/v1/tool': post(
        'Tool dispatcher',
        'MCP-style call: {"tool": "stack_analyze", "arguments": {...}}. Returns the same body as the matching route.',
        toolRequest,
        { description: 'Result of the dispatched tool', content: { 'application/json': { schema: { type: 'object' } } } },
      ),
    },
    components: { schemas: components },
  };
}
