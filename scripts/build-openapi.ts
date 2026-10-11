/**
 * Write openapi/openapi.json from src/openapi.ts.
 *   npx tsx scripts/build-openapi.ts           # write
 *   npx tsx scripts/build-openapi.ts --check   # fail if the committed file is stale
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApi } from '../src/openapi.js';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../openapi/openapi.json');
const text = `${JSON.stringify(buildOpenApi(), null, 2)}\n`;

if (process.argv.includes('--check')) {
  if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== text) {
    console.error('openapi/openapi.json is out of date. Run: npm run build:openapi');
    process.exit(1);
  }
  console.log('openapi/openapi.json is up to date.');
} else {
  writeFileSync(OUT, text);
  console.log('Wrote openapi/openapi.json');
}
