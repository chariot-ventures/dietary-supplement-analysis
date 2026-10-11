/**
 * Write openapi/openapi.json from src/openapi.ts.
 *   npx tsx scripts/build-openapi.ts           # write
 *   npx tsx scripts/build-openapi.ts --check   # fail if the committed file is stale
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GUIDE } from '../src/lib/guide.js';
import { buildOpenApi } from '../src/openapi.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputs: [string, string][] = [
  ['openapi/openapi.json', `${JSON.stringify(buildOpenApi(), null, 2)}\n`],
  ['llms.txt', GUIDE],
];

const check = process.argv.includes('--check');
let stale = false;
for (const [rel, text] of outputs) {
  const file = path.join(ROOT, rel);
  if (check) {
    if (!existsSync(file) || readFileSync(file, 'utf8') !== text) {
      console.error(`${rel} is out of date. Run: npm run build:openapi`);
      stale = true;
    } else console.log(`${rel} is up to date.`);
  } else {
    writeFileSync(file, text);
    console.log(`Wrote ${rel}`);
  }
}
if (stale) process.exit(1);
