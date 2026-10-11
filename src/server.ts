import path from 'node:path';
import warmQueries from '../data/warm-queries.json' with { type: 'json' };
import { buildApp } from './app.js';
import { DsldClient } from './lib/dsld.js';
import { createFixtureFetch, loadFixtureLabels } from './lib/dsld-fixtures.js';
import { DEFAULT_LIMITS, openFreeTier } from './lib/freetier.js';
import { RxNormClient } from './lib/interactions.js';
import { OpenFdaClient } from './lib/openfda.js';
import { openLabelStore } from './lib/store.js';
import { startWarmer } from './lib/warm.js';
import { SERVICE_ID, VERSION } from './version.js';

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? '0.0.0.0';
const fixturesDir = process.env.DSLD_FIXTURES_DIR;
// Persistent label store: on by default in the container (/data is a volume), off when the variable is empty.
const storePath = process.env.DSLD_STORE_PATH ?? '';
const opened = storePath && !fixturesDir ? await openLabelStore(storePath) : { store: null };

// Free trial on the public demo hostname(s), e.g. FREE_TIER_HOSTS=agents.trackmysupplement.com. Empty: off.
const envInt = (name: string, fallback: number) => (process.env[name] && Number.isFinite(Number(process.env[name])) ? Number(process.env[name]) : fallback);
const freeTier = await openFreeTier(
  (process.env.FREE_TIER_HOSTS ?? '').split(','),
  {
    perSession: envInt('FREE_TIER_PER_SESSION', DEFAULT_LIMITS.perSession),
    perSessionMinute: envInt('FREE_TIER_PER_SESSION_MINUTE', DEFAULT_LIMITS.perSessionMinute!),
    perIpRest: envInt('FREE_TIER_PER_IP', DEFAULT_LIMITS.perIpRest),
    perIpMcp: envInt('FREE_TIER_PER_IP_MCP', DEFAULT_LIMITS.perIpMcp),
    global: envInt('FREE_TIER_GLOBAL', DEFAULT_LIMITS.global),
  },
  process.env.FREE_TIER_DB ?? (storePath && storePath !== ':memory:' ? path.join(path.dirname(storePath), 'free-tier.sqlite') : null),
);

const dsld = new DsldClient({
  baseUrl: process.env.DSLD_BASE_URL,
  apiKey: process.env.DSLD_API_KEY,
  store: opened.store,
  ...(fixturesDir ? { fetchImpl: createFixtureFetch(loadFixtureLabels(fixturesDir)) } : {}),
});

const app = buildApp({
  dsld,
  freeTier,
  // RXNORM=off (or offline fixtures) keeps medication matching to the names in data/interactions.json.
  openfda: fixturesDir || process.env.OPENFDA === 'off' ? null : new OpenFdaClient(undefined, process.env.OPENFDA_BASE_URL || undefined, process.env.OPENFDA_API_KEY || undefined),
  rxnorm: fixturesDir || process.env.RXNORM === 'off' ? null : new RxNormClient(undefined, process.env.RXNORM_BASE_URL || undefined),
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  ...(process.env.UPSTREAM_BUDGET_MS ? { upstreamBudgetMs: Number(process.env.UPSTREAM_BUDGET_MS) } : {}),
});

async function main(): Promise<void> {
  await app.listen({ port, host });
  app.log.info(
    { service: SERVICE_ID, version: VERSION, dsld: fixturesDir ? 'fixtures' : 'live', label_store: opened.store ? { path: storePath, labels: opened.store.count() } : (opened.error ?? 'off') },
    'listening',
  );
  if (opened.store && process.env.DSLD_WARM !== '0') {
    startWarmer(dsld, {
      queries: warmQueries.queries,
      perQuery: warmQueries.per_query,
      log: (msg, data) => app.log.info(data ?? {}, msg),
    });
  }

  // Optional cache pre-warm, e.g. the DSLD IDs used in README examples.
  const prewarm = (process.env.DSLD_PREWARM_IDS ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (prewarm.length) {
    const results = await Promise.allSettled(prewarm.map((id) => dsld.getLabel(id)));
    app.log.info({ prewarmed: results.filter((r) => r.status === 'fulfilled').length, requested: prewarm.length }, 'prewarm done');
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.close().finally(() => process.exit(0));
  });
}

main().catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
