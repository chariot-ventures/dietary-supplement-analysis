import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { AppError } from './lib/errors.js';
import { escapeGatewayPhrases } from './lib/phrases.js';
import { registerMetaRoutes } from './routes/meta.js';
import { registerNutrientRoutes } from './routes/nutrients.js';
import { registerProductRoutes } from './routes/products.js';
import { registerStackRoutes } from './routes/stack.js';
import { registerToolRoute } from './routes/tool.js';
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

  registerMetaRoutes(app);
  registerNutrientRoutes(app);
  registerProductRoutes(app, opts);
  registerStackRoutes(app, opts);
  registerToolRoute(app, opts);
  return app;
}
