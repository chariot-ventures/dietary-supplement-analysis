import type { FastifyInstance } from 'fastify';
import { buildOpenApi } from '../openapi.js';
import { DOCS_URL, SERVICE_ID, VERSION } from '../version.js';

export function registerMetaRoutes(app: FastifyInstance): void {
  const openapi = buildOpenApi();
  app.get('/', async () => ({ service: SERVICE_ID, status: 'ok', version: VERSION, docs: DOCS_URL, openapi: '/openapi.json', tools: '/v1/tools', guide: '/v1/guide' }));
  app.get('/v1/version', async () => ({ service: SERVICE_ID, version: VERSION }));
  app.get('/v1/health', async () => ({ status: 'ok' }));
  app.get('/openapi.json', async () => openapi);
}
