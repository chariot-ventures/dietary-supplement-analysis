/**
 * Record real DSLD labels as test fixtures (needs outbound HTTPS to api.ods.od.nih.gov).
 *
 *   npx tsx scripts/record-fixtures.ts 12345 67890            # record labels by ID
 *   npx tsx scripts/record-fixtures.ts --search "vitamin d3"   # print top on-market IDs for a query
 *
 * Writes test/fixtures/dsld/real/label-<id>.json. Recorded labels are real
 * NIH data and can back the README / judge examples.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DsldClient } from '../src/lib/dsld.js';
import { normalizeDsldLabel } from '../src/lib/label.js';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../test/fixtures/dsld/real');
const client = new DsldClient({ apiKey: process.env.DSLD_API_KEY, baseUrl: process.env.DSLD_BASE_URL });
const args = process.argv.slice(2);

if (args[0] === '--search') {
  const res = await client.search({ query: args.slice(1).join(' '), onMarketOnly: true, size: 10 });
  console.log(`total hits: ${res.total}`);
  for (const id of res.ids) {
    const { label } = await client.getLabel(id);
    console.log(`${id}\t${label.brandName ?? ''}\t${label.fullName ?? ''}`);
  }
} else {
  mkdirSync(OUT, { recursive: true });
  for (const id of args.map(Number).filter((n) => Number.isInteger(n) && n > 0)) {
    const { label } = await client.getLabel(id);
    writeFileSync(path.join(OUT, `label-${id}.json`), `${JSON.stringify(label, null, 2)}\n`);
    const n = normalizeDsldLabel(label);
    console.log(`${id}: ${n.brand} ${n.name} - ${n.ingredients.length} nutrients, ${n.unrecognized_ingredients.length} unrecognized, ${n.data_gaps.length} gaps`);
  }
}
