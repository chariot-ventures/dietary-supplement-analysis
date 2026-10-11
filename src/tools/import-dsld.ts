/**
 * Imports the NIH DSLD full-database dump into the label store.
 *
 * Reads newline-delimited label JSON (one DSLD label per line, as in the
 * dump's per-label files) on stdin and upserts each into the store in
 * batches, so a running server keeps answering. deploy/mirror/dsld-mirror.sh
 * streams the zip into it:
 *
 *   python3 stream-zip.py dsld.zip | docker exec -i <backend> node dist/src/tools/import-dsld.js /data/dsld.sqlite "<version>"
 */
import { createInterface } from 'node:readline';
import type { DsldLabel } from '../lib/dsld.js';
import { openLabelStore } from '../lib/store.js';

const [file = '/data/dsld.sqlite', version = 'unknown', retrieved = new Date().toISOString().slice(0, 10)] = process.argv.slice(2);
const BATCH = 500;

const opened = await openLabelStore(file);
if (!opened.store) {
  console.error(`cannot open label store: ${opened.error}`);
  process.exit(1);
}
const store = opened.store;
let batch: DsldLabel[] = [];
let imported = 0;
let skipped = 0;

const flush = () => {
  if (!batch.length) return;
  const b = batch;
  batch = [];
  store.transaction(() => {
    for (const l of b) store.putLabel(l, retrieved);
  });
  imported += b.length;
  if (imported % 20000 < BATCH) console.log(JSON.stringify({ msg: 'import progress', imported, skipped }));
};

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  try {
    const l = JSON.parse(line) as DsldLabel;
    if (typeof l.id !== 'number' || !Array.isArray(l.ingredientRows)) {
      skipped++;
      continue;
    }
    batch.push(l);
  } catch {
    skipped++;
  }
  if (batch.length >= BATCH) flush();
}
flush();
store.setMeta('mirror_version', version);
store.setMeta('mirror_imported_at', new Date().toISOString());
store.setMeta('mirror_labels', String(imported));
console.log(JSON.stringify({ msg: 'import done', imported, skipped, total_in_store: store.count(), version }));
store.close();
