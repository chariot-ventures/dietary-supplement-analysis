/**
 * Are the NIH pages our data comes from newer than our review?
 *
 * Collects every NIH ODS and NCCIH page cited in data/*.json, reads each page's
 * "Updated"/"Last Updated" date, and compares it with data/factsheet-dates.json
 * (the dates when we last reviewed the data against them).
 *
 *   npx tsx scripts/check-factsheets.ts            # print a report; exit 1 when a page changed
 *   npx tsx scripts/check-factsheets.ts --write    # record the current dates as reviewed
 *
 * Run monthly by .github/workflows/factsheets.yml, which opens an issue on changes.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const DATES = 'data/factsheet-dates.json';
const FILES = ['data/nutrients.json', 'data/interactions.json', 'data/botanicals.json', 'data/source/manual.json'];

function urls(): string[] {
  const found = new Set<string>();
  for (const f of FILES) {
    if (!existsSync(f)) continue;
    for (const m of readFileSync(f, 'utf8').matchAll(/https:\/\/(?:ods\.od\.nih\.gov\/factsheets|www\.nccih\.nih\.gov\/health)\/[A-Za-z0-9-]+\/?/g)) {
      found.add(m[0].endsWith('/') || m[0].includes('nccih') ? m[0] : `${m[0]}/`);
    }
  }
  return [...found].sort();
}

const MONTHS = 'January February March April May June July August September October November December'.split(' ');
export function updatedDate(html: string): string | null {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  // ODS: "Updated: June 2, 2022"; NCCIH: "Last Updated: February 2025" (month only -> the 1st).
  const m = text.match(/(?:Last\s+)?Updated:?\s*([A-Z][a-z]+)\s+(?:(\d{1,2}),\s*)?(\d{4})/);
  if (!m || !MONTHS.includes(m[1]!)) return null;
  return `${m[3]}-${String(MONTHS.indexOf(m[1]!) + 1).padStart(2, '0')}-${(m[2] ?? '1').padStart(2, '0')}`;
}

async function main() {
  const recorded: Record<string, string> = existsSync(DATES) ? JSON.parse(readFileSync(DATES, 'utf8')).pages ?? {} : {};
  const current: Record<string, string | null> = {};
  const why: Record<string, string> = {};
  for (const u of urls()) {
    try {
      const res = await fetch(u, {
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; dietary-supplement-analysis fact-sheet check; +https://github.com/chariot-ventures/dietary-supplement-analysis)',
          accept: 'text/html,application/xhtml+xml',
          'accept-language': 'en-US,en;q=0.9',
        },
      });
      current[u] = res.ok ? updatedDate(await res.text()) : null;
      if (!current[u]) why[u] = res.ok ? 'no "Updated" date on the page' : `HTTP ${res.status}`;
    } catch (err) {
      current[u] = null;
      why[u] = err instanceof Error ? err.message : 'fetch failed';
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const changed = Object.entries(current).filter(([u, d]) => d && recorded[u] && d > recorded[u]!);
  const unknown = Object.entries(current).filter(([u, d]) => d && !recorded[u]);
  // ODS sits behind Cloudflare, which refuses data-center addresses: those pages are checked by hand.
  const odsBlocked = Object.entries(current).filter(([u, d]) => !d && u.includes('ods.od.nih.gov') && /HTTP 403/.test(why[u] ?? ''));
  const unreadable = Object.entries(current).filter(([u, d]) => !d && !odsBlocked.some(([b]) => b === u));

  if (process.argv.includes('--write')) {
    const pages = Object.fromEntries(Object.entries(current).map(([u, d]) => [u, d ?? recorded[u] ?? 'unknown']));
    // Keep the _doc note (ODS is recorded by hand).
    const doc = existsSync(DATES) ? JSON.parse(readFileSync(DATES, 'utf8'))._doc : undefined;
    writeFileSync(DATES, `${JSON.stringify({ _doc: doc ?? 'NIH page "Updated" dates as of our last review of data/*.json against them.', checked: new Date().toISOString().slice(0, 10), pages }, null, 1)}\n`);
    console.log(`Recorded ${Object.keys(pages).length} pages in ${DATES}`);
    return;
  }
  const lines = [
    `Checked ${Object.keys(current).length} NIH pages cited in data/.`,
    changed.length ? `\n**Updated since our review (${changed.length}):**\n${changed.map(([u, d]) => `- ${u}: ${recorded[u]} -> ${d}`).join('\n')}` : '\nNo cited page has changed since our review.',
    unknown.length ? `\nNot yet recorded (${unknown.length}): ${unknown.map(([u, d]) => `${u} (${d})`).join(', ')}` : '',
    odsBlocked.length
      ? `\nODS pages (${odsBlocked.length}) refuse automated checks; their recorded review dates run to ${odsBlocked.map(([u]) => recorded[u] ?? '').sort().pop()}. Check https://ods.od.nih.gov/HealthInformation/factsheets.aspx by hand, or subscribe to ODS updates: https://ods.od.nih.gov/News/ODS_ListServ.aspx`
      : '',
    unreadable.length ? `\nNo date found (${unreadable.length}): ${unreadable.map(([u]) => `${u} (${why[u]})`).join(', ')}` : '',
    changed.length || unknown.length ? '\nReview the data for the changed pages, then run `npx tsx scripts/check-factsheets.ts --write` and commit data/factsheet-dates.json.' : '',
  ];
  console.log(lines.filter(Boolean).join('\n'));
  if (changed.length || unknown.length) process.exitCode = 1;
}

if (process.argv[1]?.endsWith('check-factsheets.ts')) await main();
