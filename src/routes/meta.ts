import type { FastifyInstance } from 'fastify';
import { buildOpenApi } from '../openapi.js';
import { provenance } from '../lib/provenance.js';
import { DOCS_URL, SERVICE_ID, VERSION } from '../version.js';
import type { Deps } from './deps.js';

export function registerMetaRoutes(app: FastifyInstance, deps?: Deps): void {
  const openapi = buildOpenApi();
  // Browsers on the demo host get the landing page (routes/site.ts); agents and relays get JSON.
  app.get('/', async (req, reply) => {
    if (app.sitePage(req, reply)) return reply;
    return { service: SERVICE_ID, status: 'ok', version: VERSION, docs: DOCS_URL, openapi: '/openapi.json', tools: '/v1/tools', guide: '/v1/guide', llms_txt: '/llms.txt', status_page: '/status.json' };
  });
  app.get('/v1/version', async () => ({ service: SERVICE_ID, version: VERSION }));
  app.get('/v1/health', async () => ({ status: 'ok' }));
  app.get('/v1/provenance', async () => provenance(deps?.dsld.store));
  app.get('/openapi.json', async () => openapi);
}
