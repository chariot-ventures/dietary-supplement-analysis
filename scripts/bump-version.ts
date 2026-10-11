/**
 * Sets the service version everywhere it appears, and opens a CHANGELOG entry.
 *
 *   npm run bump -- 0.13.0        # or: patch | minor
 *
 * Then edit the CHANGELOG entry, run `npm run check` (it refreshes nothing by
 * itself: run `npm run build:openapi` and `npx vitest run -u` for snapshots),
 * and push to the release branch.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const current = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
const arg = process.argv[2];
if (!arg) {
  console.error('usage: npm run bump -- <x.y.z | patch | minor>');
  process.exit(2);
}
const [maj, min, pat] = current.split('.').map(Number) as [number, number, number];
const next = arg === 'patch' ? `${maj}.${min}.${pat + 1}` : arg === 'minor' ? `${maj}.${min + 1}.0` : arg;
if (!/^\d+\.\d+\.\d+$/.test(next)) {
  console.error(`not a version: ${next}`);
  process.exit(2);
}

const edits: [string, (s: string) => string][] = [
  ['package.json', (s) => s.replace(`"version": "${current}"`, `"version": "${next}"`)],
  ['src/version.ts', (s) => s.replace(`'${current}'`, `'${next}'`)],
  ['test/app.test.ts', (s) => s.split(`'${current}'`).join(`'${next}'`)],
  ['README.md', (s) => s.split(`"version":"${current}"`).join(`"version":"${next}"`)],
  ['OPERATORS.md', (s) => s.split(`"version":"${current}"`).join(`"version":"${next}"`)],
];
for (const [file, fn] of edits) {
  const before = readFileSync(file, 'utf8');
  const after = fn(before);
  if (after === before) console.warn(`${file}: no version string found`);
  writeFileSync(file, after);
}
for (const file of ['package-lock.json', 'mcp/server.json']) {
  const j = JSON.parse(readFileSync(file, 'utf8')) as { version: string; packages?: Record<string, { version?: string }> };
  j.version = next;
  if (j.packages?.['']) j.packages[''].version = next;
  writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`);
}
const log = readFileSync('CHANGELOG.md', 'utf8');
if (!log.includes(`## ${next} `)) {
  writeFileSync('CHANGELOG.md', log.replace('# Changelog\n\n', `# Changelog\n\n## ${next} (${new Date().toISOString().slice(0, 10)})\n\n- \n\n`));
}
console.log(`${current} -> ${next}. Edit CHANGELOG.md, then: npm run build:openapi && npx vitest run -u && npm run check`);
