import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { provenance } from '../lib/provenance.js';
import { agentsMd, aiTxt, CONTACT_EMAIL, FREE_TRIAL, landingPage, llmsFullTxt, llmsTxt, MACHINE_FILES, MCP_URL, mcpServerEntry, POCKET, REPO_URL, robotsTxt, SITE_URL, sitemapXml } from '../lib/site-content.js';
import { SERVICE_ID, VERSION } from '../version.js';
import type { Deps } from './deps.js';
import { toolDefinitions } from './tools.js';

const STARTED_AT = new Date();

/** Accuracy result recorded by `npm run eval -- --write` (eval/results.json, copied into the image). */
function readAccuracy(): { passed: number; total: number; service_version: string; details: string } | null {
  try {
    const file = path.resolve('eval/results.json');
    if (!existsSync(file)) return null;
    const r = JSON.parse(readFileSync(file, 'utf8')) as { version?: string; passed?: number; total?: number };
    if (typeof r.passed !== 'number' || typeof r.total !== 'number') return null;
    return { passed: r.passed, total: r.total, service_version: r.version ?? 'unknown', details: `${REPO_URL}/blob/main/EVAL.md` };
  } catch {
    return null;
  }
}
const ACCURACY = readAccuracy();

/**
 * Pages and text files for people and crawlers, on the public demo host only.
 * Everywhere else (the relayer's backend address) these paths are 404 JSON, so
 * paid relays only ever see JSON objects. GET / keeps answering JSON unless a
 * browser on the demo host asks for HTML.
 */
export function registerSiteRoutes(app: FastifyInstance, deps: Deps, siteHosts: string[]): void {
  const hosts = new Set(siteHosts.map((h) => h.trim().toLowerCase()).filter(Boolean));
  const onSite = (req: FastifyRequest) => hosts.has(String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, ''));
  const tools = toolDefinitions();
  const page = landingPage(tools);
  const files: Record<string, [string, string]> = {
    '/llms.txt': ['text/plain; charset=utf-8', llmsTxt()],
    '/.well-known/llms.txt': ['text/plain; charset=utf-8', llmsTxt()],
    '/llms-full.txt': ['text/plain; charset=utf-8', llmsFullTxt(tools)],
    '/agents.md': ['text/markdown; charset=utf-8', agentsMd()],
    '/robots.txt': ['text/plain; charset=utf-8', robotsTxt()],
    '/ai.txt': ['text/plain; charset=utf-8', aiTxt()],
    '/sitemap.xml': ['application/xml; charset=utf-8', sitemapXml()],
  };

  const sendText = (reply: FastifyReply, type: string, body: string) =>
    reply.header('content-type', type).header('cache-control', 'public, max-age=300').header('x-content-type-options', 'nosniff').send(body);

  for (const [url, [type, body]] of Object.entries(files)) {
    app.get(url, async (req, reply) => {
      if (onSite(req)) return sendText(reply, type, body);
      reply.callNotFound();
      return reply;
    });
  }

  /** The landing page, for browsers on the demo host; called from GET / in meta.ts. */
  app.decorate('sitePage', (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!onSite(req) || !/\btext\/html\b/.test(String(req.headers.accept ?? ''))) return false;
    reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'public, max-age=300')
      .header('vary', 'Accept')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
      .send(page);
    return true;
  });

  // JSON, so it is served on every host: the official MCP Registry entry for this server.
  app.get('/.well-known/mcp.json', async () => mcpServerEntry());

  // Live status for people, agents and directories that check before they list or call.
  app.get('/status.json', async () => {
    const p = provenance(deps.dsld.store);
    return {
      service: SERVICE_ID,
      version: VERSION,
      status: 'ok',
      started_at: STARTED_AT.toISOString(),
      uptime_seconds: Math.round((Date.now() - STARTED_AT.getTime()) / 1000),
      commit: p.commit,
      accuracy: ACCURACY,
      monitoring: { live_check: 'End-to-end checks of the public service every 30 minutes, and the Pocket portal audit daily', history: `${REPO_URL}/actions/workflows/live-check.yml` },
      data: {
        labels_in_store: p.data.labels.mirror?.labels_in_store ?? null,
        nih_label_edition: p.data.labels.mirror?.version ?? null,
        reference_values_reviewed: p.data.reference_values.reviewed,
        details: `${SITE_URL}/v1/provenance`,
      },
      access: { mcp: MCP_URL, rest: SITE_URL, openapi: `${SITE_URL}/openapi.json`, free_trial: FREE_TRIAL },
      pocket: POCKET,
      files: Object.fromEntries(MACHINE_FILES.map(([href, label]) => [href, label])),
      contact: CONTACT_EMAIL,
    };
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    sitePage(req: FastifyRequest, reply: FastifyReply): boolean;
  }
}
