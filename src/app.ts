import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { AppError } from './lib/errors.js';
import { limitMessage, PAID_ROUTE_URL } from './lib/freetier.js';
import { escapeGatewayPhrases } from './lib/phrases.js';
import { registerFdaRoutes } from './routes/fda.js';
import { registerInteractionRoutes } from './routes/interactions.js';
import { registerMcpRoute } from './routes/mcp.js';
import { registerMetaRoutes } from './routes/meta.js';
import { registerNutrientRoutes } from './routes/nutrients.js';
import { registerProductRoutes } from './routes/products.js';
import { registerSiteRoutes } from './routes/site.js';
import { registerStackRoutes } from './routes/stack.js';
import { registerToolRoute } from './routes/tool.js';
import { registerToolsRoutes } from './routes/tools.js';
import type { Deps } from './routes/deps.js';

export interface AppOptions extends Deps {
  logger?: FastifyServerOptions['logger'];
}

/**
 * Gateway rules (PLAN.md section 4): every body is a JSON object, client
 * errors are 4xx, nothing 5xx, no compression, any content type parsed as
 * JSON, chunked bodies accepted, request bodies never logged.
 */
export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ?? false,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 256 * 1024,
    return503OnClosing: false,
    routerOptions: { ignoreTrailingSlash: true },
  });

  // Upstream and caller text (product names, echoed queries) can contain phrases the gateway treats as failures.
  app.setReplySerializer((payload) => escapeGatewayPhrases(JSON.stringify(payload)));

  // Parse every body as JSON regardless of Content-Type (gateways may drop or rewrite it).
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new AppError('INVALID_INPUT', 'Request body must be valid JSON', { field: 'body' }), undefined);
    }
  });

  app.addHook('onResponse', async (req, reply) => {
    // Method, path, status and duration only. Never the body or query string.
    req.log.info({ method: req.method, path: req.routeOptions.url ?? 'unmatched', status: reply.statusCode, ms: Math.round(reply.elapsedTime) });
  });

  // Free trial on the demo hostname: metered POST calls (paid relays never come in on that host).
  const metered = new Set(['/v1/stack/analyze', '/v1/products/search', '/v1/products/lookup', '/v1/products/get', '/v1/products/fda', '/v1/nutrients/reference', '/v1/interactions/check', '/v1/tool']);
  const freeTier = opts.freeTier ?? null;
  if (freeTier?.enabled) {
    app.addHook('preHandler', async (req, reply) => {
      if (req.method !== 'POST' || !metered.has(req.routeOptions.url ?? '') || !freeTier.applies(req)) return;
      const v = freeTier.take('rest', freeTier.clientIp(req));
      if (!v.ok) {
        const body = new AppError('RATE_LIMITED', limitMessage(v)).toBody();
        return reply.code(429).header('retry-after', String(Math.max(60, Math.round((Date.parse(v.resets_at) - Date.now()) / 1000)))).send({ ...body, free_tier: { scope: v.scope, limit: v.limit, resets_at: v.resets_at, paid_route: PAID_ROUTE_URL } });
      }
      reply.header('x-free-tier-limit', String(v.limit)).header('x-free-tier-remaining', String(v.remaining)).header('x-free-tier-reset', v.resets_at);
    });
  }

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send(err.toBody());
    const e = err as { statusCode?: number; message?: string; code?: string };
    const status = typeof e.statusCode === 'number' ? e.statusCode : 0;
    if (status >= 400 && status < 500) {
      const message = e.code === 'FST_ERR_CTP_BODY_TOO_LARGE' ? 'Request body is too large (max 256 KB)' : (e.message ?? 'Invalid request');
      return reply.code(status).send(new AppError('INVALID_INPUT', message, { field: 'body' }).toBody());
    }
    req.log.error({ path: req.routeOptions.url, err: e.message }, 'unhandled error');
    return reply.code(422).send(new AppError('INTERNAL_ERROR', 'The request could not be processed', { retryable: false }).toBody());
  });

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send(new AppError('NOT_FOUND', `No route for ${req.method} ${req.url.split('?')[0]}. See GET /openapi.json`).toBody()),
  );

  registerSiteRoutes(app, opts, opts.siteHosts ?? []);
  registerMetaRoutes(app, opts);
  registerNutrientRoutes(app);
  registerProductRoutes(app, opts);
  registerStackRoutes(app, opts);
  registerInteractionRoutes(app, opts);
  registerFdaRoutes(app, opts);
  registerToolRoute(app, opts);
  registerToolsRoutes(app);
  registerMcpRoute(app, opts);
  return app;
}
