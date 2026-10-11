import type { FastifyInstance } from 'fastify';
import { GUIDE } from '../lib/guide.js';
import { requestSchema } from '../openapi.js';
import { analyzeRequest, getRequest, lookupRequest, referenceRequest, searchRequest } from '../schemas/requests.js';
import { DOCS_URL, SERVICE_ID, VERSION } from '../version.js';

/**
 * Tool definitions for function-calling agents (MCP / Anthropic "input_schema" shape).
 * Each tool maps to a POST route and to POST /v1/tool {"tool": name, "arguments": {...}}.
 */
export function toolDefinitions() {
  return [
    {
      name: 'stack_analyze',
      path: '/v1/stack/analyze',
      description:
        'Check a list of dietary supplements for a person: per-nutrient daily totals against NIH upper limits (UL) and RDA/AI, which products overlap, what each UL protects against, and single-product changes that would bring an above-UL nutrient back under it. Products can be given as names ("Centrum Silver Women 50+"), barcodes, DSLD IDs, or custom ingredient lists; optional candidates are evaluated as additions. Returns agent_summary (plain sentences to relay), resolutions, suggestions, nutrient_totals and data_gaps. Label data only; food and medications are not included.',
      input_schema: requestSchema(analyzeRequest),
    },
    {
      name: 'products_search',
      path: '/v1/products/search',
      description: 'Search the NIH Dietary Supplement Label Database by product name, brand or ingredient. Returns up to 10 products (one per product; older label versions listed in other_versions) with DSLD IDs.',
      input_schema: requestSchema(searchRequest),
    },
    {
      name: 'products_lookup',
      path: '/v1/products/lookup',
      description: 'Look up a supplement by the UPC/EAN barcode printed on the bottle. Returns the newest matching DSLD label, normalized, and any older versions.',
      input_schema: requestSchema(lookupRequest),
    },
    {
      name: 'products_get',
      path: '/v1/products/get',
      description: 'Full normalized supplement labels by DSLD ID (up to 10): every ingredient with label amount, converted amount, form and %DV.',
      input_schema: requestSchema(getRequest),
    },
    {
      name: 'nutrients_reference',
      path: '/v1/nutrients/reference',
      description: 'NIH reference values (RDA, EAR, AI, UL) for one vitamin or mineral at a given age and sex, with what the UL protects against. Offline and instant.',
      input_schema: requestSchema(referenceRequest),
    },
  ];
}

export function registerToolsRoutes(app: FastifyInstance): void {
  const tools = toolDefinitions();
  app.get('/v1/tools', async () => ({ service: SERVICE_ID, version: VERSION, dispatcher: '/v1/tool', tools }));
  app.get('/v1/guide', async () => ({ service: SERVICE_ID, version: VERSION, format: 'text/markdown', docs: DOCS_URL, guide: GUIDE }));
}
