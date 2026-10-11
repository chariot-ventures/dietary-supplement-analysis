import type { FastifyInstance } from 'fastify';
import { parseBody, toolRequest } from '../schemas/requests.js';
import type { Deps } from './deps.js';
import { nutrientReference } from './nutrients.js';
import { getProducts, searchProducts } from './products.js';
import { analyze } from './stack.js';

/** MCP-style dispatcher: {"tool":"stack_analyze","arguments":{...}} -> same result as the matching route. */
export function registerToolRoute(app: FastifyInstance, deps: Deps): void {
  app.post('/v1/tool', async (req) => {
    const { tool, arguments: args } = parseBody(toolRequest, req.body);
    switch (tool) {
      case 'products_search':
        return searchProducts(args, deps);
      case 'products_get':
        return getProducts(args, deps);
      case 'nutrients_reference':
        return nutrientReference(args);
      case 'stack_analyze':
        return analyze(args, deps);
    }
  });
}
