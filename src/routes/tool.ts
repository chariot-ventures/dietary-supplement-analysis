import type { FastifyInstance } from 'fastify';
import { parseBody, toolRequest } from '../schemas/requests.js';
import type { Deps } from './deps.js';
import { nutrientReference } from './nutrients.js';
import { getProducts, lookupProduct, searchProducts } from './products.js';
import { fdaReports } from './fda.js';
import { checkInteractions } from './interactions.js';
import { analyze } from './stack.js';

/**
 * MCP-style dispatcher: {"tool":"stack_analyze","arguments":{...}} -> same result as the matching route.
 * "name" works in place of "tool", and {"arguments":{...}} alone runs stack_analyze.
 */
export function registerToolRoute(app: FastifyInstance, deps: Deps): void {
  app.post('/v1/tool', async (req) => {
    const body = parseBody(toolRequest, req.body);
    const tool = body.tool ?? body.name ?? 'stack_analyze';
    const args = body.arguments;
    switch (tool) {
      case 'products_search':
        return searchProducts(args, deps);
      case 'products_get':
        return getProducts(args, deps);
      case 'products_lookup':
        return lookupProduct(args, deps);
      case 'nutrients_reference':
        return nutrientReference(args);
      case 'stack_analyze':
        return analyze(args, deps);
      case 'interactions_check':
        return checkInteractions(args, deps);
      case 'products_fda_reports':
        return fdaReports(args, deps);
    }
  });
}
