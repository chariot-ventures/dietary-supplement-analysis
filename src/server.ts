import { buildApp } from './app.js';
import { DsldClient } from './lib/dsld.js';
import { createFixtureFetch, loadFixtureLabels } from './lib/dsld-fixtures.js';
import { SERVICE_ID, VERSION } from './version.js';

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? '0.0.0.0';
const fixturesDir = process.env.DSLD_FIXTURES_DIR;

const dsld = new DsldClient({
  baseUrl: process.env.DSLD_BASE_URL,
  apiKey: process.env.DSLD_API_KEY,
  ...(fixturesDir ? { fetchImpl: createFixtureFetch(loadFixtureLabels(fixturesDir)) } : {}),
});

const app = buildApp({
  dsld,
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  ...(process.env.UPSTREAM_BUDGET_MS ? { upstreamBudgetMs: Number(process.env.UPSTREAM_BUDGET_MS) } : {}),
});

async function main(): Promise<void> {
  await app.listen({ port, host });
  app.log.info({ service: SERVICE_ID, version: VERSION, dsld: fixturesDir ? 'fixtures' : 'live' }, 'listening');

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
