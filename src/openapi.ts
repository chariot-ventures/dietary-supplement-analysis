/**
 * OpenAPI 3.1 document. Request schemas are generated from the Zod schemas the
 * routes validate with; response schemas are written out here. The committed
 * copy in openapi/openapi.json is produced by scripts/build-openapi.ts and a
 * test fails if it drifts from this function.
 */
import { z } from 'zod';
import { analyzeRequest, getRequest, interactionsRequest, lookupRequest, referenceRequest, searchRequest, toolRequest } from './schemas/requests.js';
import { DOCS_URL, SERVICE_ID, VERSION } from './version.js';

type Json = Record<string, unknown>;

export function requestSchema(schema: z.ZodType): Json {
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
  MedicationMatch: {
    type: 'object',
    properties: {
      input: { type: 'string' },
      status: { type: 'string', enum: ['matched', 'not_recognized'] },
      matched_name: nullable('string'),
      via: { oneOf: [{ type: 'string', enum: ['name', 'rxnorm'] }, { type: 'null' }], description: '"rxnorm": the name was normalized to its ingredient with NIH RxNav' },
      classes: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } } },
    },
  },
  InteractionFinding: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['medication', 'condition'] },
      trigger: { type: 'string', description: 'The medication as given, or the condition id' },
      trigger_name: { type: 'string' },
      nutrient_ids: { type: 'array', items: { type: 'string' } },
      botanical_ids: { type: 'array', items: { type: 'string' }, description: 'Botanicals involved, for botanical-medication interactions (St. John\'s wort, ginkgo, kava...)' },
      in_stack: { type: 'boolean', description: 'True when the stack supplies one of the nutrients (condition findings: at or above the checked dose)' },
      product_refs: { type: 'array', items: { type: 'string' } },
      kind: { type: 'string', enum: ['supplement_changes_drug', 'drug_lowers_nutrient', 'drug_raises_nutrient', 'additive_risk', 'two_way', 'condition'] },
      summary: { type: 'string' },
      timing: nullable('string'),
      source: { type: 'object', properties: { name: { type: 'string' }, url: { type: 'string' } } },
    },
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
          'DATA_SUSPECT',
          'PRODUCT_NOT_RESOLVED',
          'INTERACTIONS_NOT_ASSESSED',
          'INTERACTIONS_PARTIAL',
          'MEDICATION_NOT_RECOGNIZED',
        ],
      },
      product_ref: { type: 'string' },
      nutrient_id: { type: 'string' },
      check: {
        type: 'string',
        enum: ['duplicate_row', 'nested_exceeds_parent', 'percent_dv_mismatch', 'implausible_amount'],
        description: 'DATA_SUSPECT only: which consistency check on the DSLD record failed',
      },
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
      entry_date: { ...nullable('string'), description: 'Date this label version was entered into DSLD' },
      other_versions: { type: 'array', items: { type: 'integer' }, description: 'DSLD IDs of older versions of the same product' },
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
      entry_date: nullable('string'),
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
      ul_basis: { ...nullable('string'), description: 'What the UL protects against (the critical adverse effect it is based on)' },
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
      coverage: {
        oneOf: [
          { type: 'object', properties: { reference: { type: 'string', enum: ['rda', 'ai'] }, percent: { type: 'number' } }, required: ['reference', 'percent'] },
          { type: 'null' },
        ],
        description: 'Percent of the RDA (or AI) supplied by these supplements alone. Informational: diet normally supplies the rest',
      },
      flags: {
        type: 'array',
        items: { type: 'string', enum: ['above_ul', 'near_ul'] },
        description: 'above_ul: the amount the UL applies to exceeds it. near_ul: 90-100% of the UL. No flag means nothing to report',
      },
      severity: { ...nullable('string'), enum: ['high', 'moderate', 'low', null], description: 'high: 2x the UL or more; moderate: above the UL; low: within 10% of the UL' },
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
  Resolution: {
    type: 'object',
    description: 'How a {query} or {upc} product was identified',
    properties: {
      input_path: { type: 'string', description: 'e.g. products.0 or candidates.1' },
      input: { type: 'object' },
      status: { type: 'string', enum: ['resolved', 'not_found'] },
      matched_by: { type: 'string', enum: ['query', 'upc'] },
      dsld_id: nullable('integer'),
      product_ref: nullable('string'),
      brand: nullable('string'),
      name: nullable('string'),
      entry_date: nullable('string'),
      confidence: { ...nullable('string'), enum: ['high', 'medium', 'low', null] },
      reason: { type: 'string' },
      other_versions: { type: 'array', items: { type: 'integer' } },
      alternatives: {
        type: 'array',
        items: {
          type: 'object',
          properties: { dsld_id: { type: 'integer' }, brand: nullable('string'), name: nullable('string'), entry_date: nullable('string'), on_market: nullable('boolean'), score: { type: 'number' } },
        },
      },
    },
  },
  Suggestion: {
    type: 'object',
    description: 'A single-product change and its arithmetic effect on an above-UL nutrient',
    properties: {
      nutrient_id: { type: 'string' },
      action: { type: 'string', enum: ['reduce_servings', 'remove_product'] },
      product_ref: { type: 'string' },
      product_name: { type: 'string' },
      servings_per_day: { type: 'number', description: 'reduce_servings only' },
      resolves: { type: 'boolean', description: 'True when this change alone brings the amount to or under the UL' },
      result: { type: 'object', properties: { amount_toward_ul: amount, percent_of_ul: { type: 'number' } } },
      also_resolves: { type: 'array', items: { type: 'string' } },
      also_lowers: { type: 'array', items: { type: 'string' } },
      text: { type: 'string' },
    },
  },
  CandidateResult: {
    type: 'object',
    description: 'Effect of adding one candidate product to the stack',
    properties: {
      product_ref: { type: 'string' },
      product_name: { type: 'string' },
      verdict: { type: 'string', enum: ['adds_above_ul', 'increases_above_ul', 'adds_near_ul', 'no_new_flags'] },
      new_flags: { type: 'array', items: { type: 'object', properties: { nutrient_id: { type: 'string' }, name: { type: 'string' }, flag: { type: 'string' }, percent_of_ul: nullable('number') } } },
      changes: {
        type: 'array',
        items: {
          type: 'object',
          properties: { nutrient_id: { type: 'string' }, from: amount, to: amount, percent_of_ul_to: nullable('number'), coverage_percent_to: nullable('number') },
        },
      },
      text: { type: 'string' },
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
  '422': { description: 'UNSUPPORTED (pregnancy or lactation outside ages 14-50)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
  '424': {
    description: 'UPSTREAM_UNAVAILABLE: NIH DSLD unreachable and nothing cached (retryable)',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
};

function post(summary: string, description: string, request: z.ZodType, response: Json, examples: Record<string, unknown> = {}): Json {
  const ex = Object.keys(examples).length ? { examples: Object.fromEntries(Object.entries(examples).map(([k, v]) => [k, { value: v }])) } : {};
  return {
    post: {
      summary,
      description,
      requestBody: { required: true, content: { 'application/json': { schema: requestSchema(request), ...ex } } },
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
          search_source: { type: 'string', enum: ['dsld', 'local'], description: '"local" when NIH DSLD was unreachable and results came from the service\'s own label store' },
          products: { type: 'array', items: { $ref: '#/components/schemas/ProductSummary' } },
        }),
        { by_name: { query: 'vitamin d3 5000', limit: 3 }, by_brand_and_ingredient: { brand: 'Thorne', ingredient: 'magnesium' } },
      ),
      '/v1/products/lookup': post(
        'Look up a product by barcode',
        'The DSLD label whose UPC matches, newest version first. Spaces and dashes in the barcode are ignored; a 13-digit EAN with a leading 0 matches its 12-digit UPC.',
        lookupRequest,
        ok('Label for the barcode', {
          upc: { type: 'string' },
          dsld_id: { type: 'integer' },
          other_versions: { type: 'array', items: { type: 'object', properties: { dsld_id: { type: 'integer' }, entry_date: nullable('string'), on_market: nullable('boolean') } } },
          product: { $ref: '#/components/schemas/Label' },
        }),
        { upc: { upc: '031604026974' } },
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
        { vitamin_d: { nutrient: 'vitamin d', age: 34, sex: 'female' }, zinc: { nutrient: 'zinc', age: 6, sex: 'male' } },
      ),
      '/v1/stack/analyze': post(
        'Analyze a supplement stack',
        'Per-nutrient daily totals across 1-15 products (product names, barcodes, DSLD IDs or custom ingredient lists), compared with upper limits and reference intakes when age and sex are given. Returns a plain-language agent_summary, how each named product was identified, single-product changes that would bring above-UL nutrients under the UL, and (with candidates) the effect of adding each candidate. No flag means nothing to report, not a judgement about the stack.',
        analyzeRequest,
        ok('Stack analysis', {
          profile: { oneOf: [{ type: 'object', properties: { age: { type: 'number' }, sex: { type: 'string' } } }, { type: 'null' }] },
          summary: {
            type: 'object',
            properties: {
              products_matched: { type: 'integer' },
              nutrients_totaled: { type: 'integer' },
              above_ul: { type: 'integer' },
              near_ul: { type: 'integer' },
              data_gaps: { type: 'integer' },
              data_suspect: { type: 'integer' },
              products_unresolved: { type: 'integer' },
              suggestions: { type: 'integer' },
            },
          },
          detail: { type: 'string', const: 'summary', description: 'Present only with "detail": "summary": the response then has profile, summary, agent_summary, resolutions, flagged, suggestions, candidate_results, data_gap_codes and provenance' },
          agent_summary: { type: 'string', description: 'Two to five plain sentences summarizing the result, ready to relay as written' },
          flagged: { type: 'array', items: { type: 'object' }, description: 'detail=summary only: flagged nutrients with amount, UL, percent, severity and UL basis' },
          data_gap_codes: { type: 'array', items: { type: 'string' }, description: 'detail=summary only' },
          provenance: {
            type: 'object',
            properties: { version: { type: 'string' }, commit: nullable('string'), reference_values_reviewed: { type: 'string' } },
            description: 'Code version, git commit and reference-data review date behind this answer; full detail at GET /v1/provenance',
          },
          resolutions: { type: 'array', items: { $ref: '#/components/schemas/Resolution' }, description: 'Present when any product was given as {query} or {upc}' },
          assumptions: { type: 'array', items: { type: 'string' } },
          suggestions: { type: 'array', items: { $ref: '#/components/schemas/Suggestion' } },
          candidate_results: { type: 'array', items: { $ref: '#/components/schemas/CandidateResult' }, description: 'Present when candidates were given' },
          botanicals: {
            type: 'array',
            description:
              'Present when the stack contains a botanical or other non-nutrient ingredient with an NIH NCCIH/ODS safety signal (ashwagandha, kava, St. John\'s wort, ginkgo, green tea extract, turmeric, black cohosh, garcinia, red yeast rice, goldenseal, berberine, yohimbe, ephedra, valerian, echinacea, creatine). Matched exactly on the DSLD ingredient group or name. Each has signals (kind, summary), the pregnancy statement, dose_findings (creatine, EGCG, valerian amounts against cited doses) and the source. Summary form: id, name, product_refs, signal, dose.',
            items: { type: 'object' },
          },
          interactions: {
            type: 'object',
            description:
              'Present when medications or conditions were given. Full form: scope, reviewed, medications (how each name was matched) and findings (all NIH-listed interactions, those involving nutrients in the stack first). Summary form: medications, in-stack findings, and a not_in_stack count.',
            properties: {
              scope: { type: 'string' },
              reviewed: { type: 'string' },
              medications: { type: 'array', items: { $ref: '#/components/schemas/MedicationMatch' } },
              findings: { type: 'array', items: { $ref: '#/components/schemas/InteractionFinding' } },
              not_in_stack: { type: 'integer' },
            },
          },
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
                entry_date: nullable('string'),
                source_url: nullable('string'),
              },
            },
          },
        }),
        {
          by_name: {
            age: 62,
            sex: 'female',
            products: [{ query: 'Centrum Silver Women 50+' }, { query: 'Thompson Zinc 50 mg', servings_per_day: 1 }, { upc: '031604026974' }],
          },
          what_if: { age: 34, sex: 'female', products: [{ dsld_id: 338022 }], candidates: [{ query: 'vitamin d3 5000 iu' }] },
          custom: { age: 6, sex: 'male', products: [{ name: 'Immune gummy', ingredients: [{ name: 'zinc', amount: 10, unit: 'mg' }] }] },
          with_medications: {
            age: 58,
            sex: 'male',
            detail: 'summary',
            medications: ['warfarin', 'Synthroid'],
            conditions: ['smoker'],
            products: [{ name: 'Daily multi', ingredients: [{ name: 'vitamin K', amount: 120, unit: 'mcg' }, { name: 'calcium', amount: 500, unit: 'mg' }] }],
          },
        },
      ),
      '/v1/interactions/check': post(
        'Medication and condition interactions',
        'Vitamin and mineral interactions for the given medications (generic or brand names, normalized with NIH RxNorm when the name is not in the list) and conditions, as listed in the NIH Office of Dietary Supplements fact sheets. Not exhaustive. To check an actual stack, pass medications to /v1/stack/analyze.',
        interactionsRequest,
        ok('Interactions', {
          summary: { type: 'object', properties: { medications: { type: 'integer' }, medications_recognized: { type: 'integer' }, findings: { type: 'integer' } } },
          scope: { type: 'string' },
          reviewed: { type: 'string' },
          medications: { type: 'array', items: { $ref: '#/components/schemas/MedicationMatch' } },
          findings: { type: 'array', items: { $ref: '#/components/schemas/InteractionFinding' } },
          data_gaps: { type: 'array', items: { $ref: '#/components/schemas/DataGap' } },
        }),
        { levothyroxine: { medications: ['levothyroxine'] }, warfarin_vitamin_k: { medications: ['Coumadin'], nutrients: ['vitamin k'] }, condition: { conditions: ['kidney_disease'] } },
      ),
      '/v1/provenance': {
        get: {
          summary: 'Code and data provenance',
          description: 'Service version, git commit (link to the exact source), and the edition or review date of each data source.',
          responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/v1/tools': {
        get: {
          summary: 'Tool definitions for function calling',
          description: 'Every operation as {name, path, description, input_schema} (JSON Schema). Call them via their path or POST /v1/tool.',
          responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/v1/guide': {
        get: {
          summary: 'Usage guide for agents',
          description: 'Markdown guide (the same text as llms.txt in the repository) inside a JSON object.',
          responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { guide: { type: 'string' } } } } } } },
        },
      },
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
