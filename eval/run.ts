/**
 * Runs every case in eval/cases.json through the service (in process, offline)
 * and scores it against the hand-checked expectations.
 *
 *   npm run eval            # print results
 *   npm run eval -- --write # also write eval/results.json and the table in EVAL.md
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { buildApp } from '../src/app.js';
import { DsldClient } from '../src/lib/dsld.js';
import { createFixtureFetch } from '../src/lib/dsld-fixtures.js';
import { VERSION } from '../src/version.js';
import { CASES, claimsFromService, score } from './score.js';

export async function runServiceEval() {
  const app = buildApp({ dsld: new DsldClient({ fetchImpl: createFixtureFetch(new Map()) }), rxnorm: null });
  const results = [];
  for (const c of CASES) {
    const res = await app.inject({ method: 'POST', url: '/v1/stack/analyze', payload: c.request });
    const body = res.json() as Record<string, unknown>;
    const problems = res.statusCode === 200 ? score(c.expect, claimsFromService(body)) : [`HTTP ${res.statusCode}: ${JSON.stringify(body)}`];
    results.push({ id: c.id, category: c.category, pass: problems.length === 0, problems });
  }
  await app.close();
  return results;
}

const isMain = process.argv[1]?.endsWith('run.ts');
if (isMain) {
  const results = await runServiceEval();
  const passed = results.filter((r) => r.pass).length;
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id}${r.pass ? '' : `\n      ${r.problems.join('\n      ')}`}`);
  console.log(`\n${passed}/${results.length} cases pass (service ${VERSION})`);

  if (process.argv.includes('--write')) {
    writeFileSync('eval/results.json', `${JSON.stringify({ version: VERSION, passed, total: results.length, results }, null, 1)}\n`);
    const byCat = new Map<string, { n: number; pass: number }>();
    for (const r of results) {
      const x = byCat.get(r.category) ?? { n: 0, pass: 0 };
      x.n++;
      if (r.pass) x.pass++;
      byCat.set(r.category, x);
    }
    const table = [
      `Service ${VERSION}: **${passed} of ${results.length} cases pass.**`,
      '',
      '| Category | Cases | Pass |',
      '|---|---|---|',
      ...[...byCat].map(([cat, x]) => `| ${cat} | ${x.n} | ${x.pass} |`),
    ].join('\n');
    const md = readFileSync('EVAL.md', 'utf8').replace(/<!-- service:start -->[\s\S]*<!-- service:end -->/, `<!-- service:start -->\n${table}\n<!-- service:end -->`);
    writeFileSync('EVAL.md', md);
  }
  if (passed !== results.length) process.exitCode = 1;
}
