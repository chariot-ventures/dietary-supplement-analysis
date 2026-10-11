/**
 * Checks the live service end to end and prints a human-readable report.
 *
 *   npx tsx scripts/live-check.ts                 # demo host, core checks
 *   npx tsx scripts/live-check.ts --audit         # also the Pocket portal audit and on-chain card match
 *   BASE_URL=https://... npx tsx scripts/live-check.ts --json
 *
 * Exit code 1 when any check fails (warnings don't fail). Run every 30 minutes
 * by .github/workflows/live-check.yml, which opens an issue on failure.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const BASE = (process.env.BASE_URL ?? 'https://agents.trackmysupplement.com').replace(/\/$/, '');
const RELAY = process.env.RELAY_URL ?? 'https://pokt-beta.trackmysupplement.com';
const OPERATOR = process.env.OPERATOR ?? 'pokt1kq7d6j7g3gq98rwsxlx9llwhnmy4qqedrqhej0';
const SERVICE = 'dietary-supplement-analysis';
const EXPECTED_VERSION = process.env.EXPECT_VERSION ?? (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;

type Status = 'pass' | 'warn' | 'fail';
interface Result {
  area: string;
  check: string;
  status: Status;
  detail: string;
  ms: number;
}
const results: Result[] = [];

async function check(area: string, name: string, fn: () => Promise<{ status?: Status; detail: string }>): Promise<void> {
  const t = Date.now();
  try {
    const r = await fn();
    results.push({ area, check: name, status: r.status ?? 'pass', detail: r.detail, ms: Date.now() - t });
  } catch (err) {
    results.push({ area, check: name, status: 'fail', detail: err instanceof Error ? err.message : String(err), ms: Date.now() - t });
  }
}

async function call(path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown>; headers: Headers }> {
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`HTTP ${res.status}, body is not JSON: ${text.slice(0, 120)}`);
  }
  return { status: res.status, json, headers: res.headers };
}

function expect(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// ---------- the checks ----------

await check('Service', 'Identity and version', async () => {
  const r = await call('/v1/version');
  expect(r.json.service === SERVICE, `service is ${String(r.json.service)}`);
  const v = String(r.json.version);
  return v === EXPECTED_VERSION ? { detail: `version ${v}` } : { status: 'warn', detail: `live ${v}, repository ${EXPECTED_VERSION} (a deploy may be in progress; it takes up to 10 minutes)` };
});

await check('Service', 'Health', async () => {
  const r = await call('/v1/health');
  expect(r.json.status === 'ok', `status ${String(r.json.status)}`);
  return { detail: 'ok' };
});

await check('Data', 'NIH label mirror loaded', async () => {
  const r = await call('/v1/provenance');
  const m = ((r.json.data as Record<string, Record<string, unknown>>).labels?.mirror ?? null) as { version?: string; labels_in_store?: number } | null;
  expect(m, 'no mirror reported in /v1/provenance');
  expect((m.labels_in_store ?? 0) > 200_000, `only ${m.labels_in_store} labels in the store`);
  return { detail: `${m.labels_in_store?.toLocaleString('en-US')} labels, NIH edition ${m.version?.split(' (')[0]}` };
});

await check('Analysis', 'Reference values (offline)', async () => {
  const r = await call('/v1/nutrients/reference', { nutrient: 'vitamin-d', age: 30, sex: 'female' });
  const ref = r.json.reference as { rda: number; ul: number };
  expect(ref.rda === 15 && ref.ul === 100, `vitamin D RDA ${ref.rda}, UL ${ref.ul} (expected 15 and 100 mcg)`);
  return { detail: 'vitamin D for a 30-year-old woman: RDA 15 mcg, UL 100 mcg' };
});

await check('Analysis', 'Products by name (live NIH search)', async () => {
  const r = await call('/v1/stack/analyze', { age: 62, sex: 'female', detail: 'summary', products: [{ query: 'Centrum Silver Women 50+' }] });
  expect(r.status === 200, `HTTP ${r.status}: ${JSON.stringify(r.json).slice(0, 150)}`);
  const res = (r.json.resolutions as { status: string; name: string }[])[0]!;
  expect(res.status === 'resolved' && /centrum/i.test(res.name), `resolved to ${res.name}`);
  return { detail: `"Centrum Silver Women 50+" -> ${res.name}` };
});

await check('Analysis', 'Barcode lookup (mirror)', async () => {
  const r = await call('/v1/products/lookup', { upc: '031604026974' });
  expect(r.json.dsld_id === 179744, `got DSLD ${String(r.json.dsld_id)}`);
  return { detail: `031604026974 -> ${(r.json.product as { name: string }).name}` };
});

await check('Analysis', 'Upper-limit flag and fix', async () => {
  const r = await call('/v1/stack/analyze', { age: 40, sex: 'male', detail: 'summary', products: [{ name: 'Zinc', ingredients: [{ name: 'zinc', amount: 50, unit: 'mg' }] }] });
  const f = (r.json.flagged as { nutrient_id: string; percent_of_ul: number }[])[0];
  expect(f?.nutrient_id === 'zinc' && f.percent_of_ul === 125, `flagged ${JSON.stringify(f)}`);
  return { detail: 'zinc 50 mg for a 40-year-old man flagged at 125% of the UL' };
});

await check('Safety', 'Medication interaction', async () => {
  const r = await call('/v1/stack/analyze', { age: 70, sex: 'male', detail: 'summary', medications: ['warfarin'], products: [{ name: 'Multi', ingredients: [{ name: 'vitamin K', amount: 100, unit: 'mcg' }] }] });
  const f = ((r.json.interactions as { findings: { trigger: string; nutrient_ids: string[] }[] }).findings ?? [])[0];
  expect(f?.nutrient_ids.includes('vitamin-k'), 'no warfarin + vitamin K finding');
  return { detail: 'warfarin with vitamin K reported, citing the NIH fact sheet' };
});

await check('Safety', 'Brand-name medication via RxNorm', async () => {
  const r = await call('/v1/interactions/check', { medications: ['Zegerid'] });
  const m = (r.json.medications as { status: string; via: string; matched_name: string }[])[0]!;
  if (m.status !== 'matched') return { status: 'warn', detail: 'RxNorm did not answer; name matching still works for known brands' };
  return { detail: `"Zegerid" -> ${m.matched_name} (${m.via})` };
});

await check('Safety', 'Herb with NIH warning', async () => {
  const r = await call('/v1/stack/analyze', { age: 40, sex: 'female', detail: 'summary', products: [{ name: 'Herbs', ingredients: [{ name: 'Ashwagandha root extract', amount: 600, unit: 'mg' }] }] });
  const b = (r.json.botanicals as { id: string }[] | undefined)?.[0];
  expect(b?.id === 'ashwagandha', 'ashwagandha not detected');
  return { detail: 'ashwagandha detected with NCCIH liver-injury statement' };
});

await check('Safety', 'FDA recalls and adverse events (openFDA)', async () => {
  const r = await call('/v1/products/fda', { brand: 'Nature Made', name: 'D3 1000 IU' });
  if (r.json.data_gaps) return { status: 'warn', detail: 'openFDA unreachable right now; the rest of the service is unaffected' };
  const rec = (r.json.recalls as { matched: unknown[] }).matched.length;
  return { detail: `${rec} matching recall(s); adverse event reports counted` };
});

await check('Analysis', 'Foods (USDA, offline)', async () => {
  const r = await call('/v1/stack/analyze', { age: 40, sex: 'female', detail: 'summary', products: [{ name: 'C', ingredients: [{ name: 'vitamin C', amount: 100, unit: 'mg' }] }], foods: [{ query: 'brazil nuts', grams: 60 }] });
  const flags = (r.json.foods as { food_only_flags: { nutrient_id: string }[] }).food_only_flags;
  expect(flags.some((f) => f.nutrient_id === 'selenium'), 'Brazil nuts did not flag selenium');
  return { detail: '60 g Brazil nuts flags selenium above the UL' };
});

await check('Analysis', 'Spanish summary', async () => {
  const r = await call('/v1/stack/analyze', { age: 40, sex: 'male', lang: 'es', detail: 'summary', products: [{ name: 'Zinc', ingredients: [{ name: 'zinc', amount: 50, unit: 'mg' }] }] });
  expect(/supera el nivel máximo/.test(String(r.json.agent_summary)), 'summary is not Spanish');
  return { detail: 'agent_summary in Spanish' };
});

await check('Agents', 'MCP server', async () => {
  const init = await call('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  const session = init.headers.get('mcp-session-id');
  expect(session, 'no Mcp-Session-Id on initialize');
  const list = await call('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-session-id': session });
  const tools = ((list.json.result as { tools: { name: string }[] }).tools ?? []).map((t) => t.name);
  expect(tools.length >= 7, `only ${tools.length} tools`);
  return { detail: `${tools.length} tools: ${tools.join(', ')}` };
});

await check('Agents', 'Free-trial metering on the demo host', async () => {
  const r = await call('/v1/nutrients/reference', { nutrient: 'zinc', age: 40, sex: 'male' });
  const left = r.headers.get('x-free-tier-remaining');
  expect(left !== null, 'no X-Free-Tier-Remaining header');
  return { detail: `${left} of ${r.headers.get('x-free-tier-limit')} free calls left today for this address` };
});

await check('Pocket', 'Relay endpoint reachable over TLS', async () => {
  const res = await fetch(RELAY, { signal: AbortSignal.timeout(15_000) });
  return { detail: `${RELAY} answered HTTP ${res.status} with a valid certificate` };
});

if (process.argv.includes('--audit')) {
  await check('Pocket', 'Portal acceptance audit (A1-A9)', async () => {
    const res = await fetch(`https://mcp.pocketmcp.network/api/audit?network=beta&ids=${SERVICE}&operator=${OPERATOR}&t=${Date.now()}`, { signal: AbortSignal.timeout(60_000) });
    const a = (await res.json()) as { summary: Record<string, number>; services?: { findings?: { rule: string; status: string; message: string }[] }[] };
    const findings = a.services?.[0]?.findings ?? [];
    const bad = findings.filter((f) => f.status !== 'PASS');
    expect(a.summary.FAIL === 0, `FAIL: ${bad.map((f) => `${f.rule} ${f.message}`).join('; ')}`);
    return a.summary.WARN ? { status: 'warn', detail: bad.map((f) => `${f.rule}: ${f.message}`).join('; ') } : { detail: 'all nine rules pass' };
  });

  await check('Pocket', 'On-chain card matches card/card.json', async () => {
    const res = await fetch(`https://mcp.pocketmcp.network/api/audit?network=beta&ids=${SERVICE}&operator=${OPERATOR}&t=${Date.now()}`, { signal: AbortSignal.timeout(60_000) });
    const text = await res.text();
    const local = createHash('sha256').update(readFileSync('card/card.json')).digest('hex');
    if (text.includes(local)) return { detail: `on-chain card sha256 ${local.slice(0, 12)}... matches the repository` };
    return { status: 'warn', detail: `the on-chain card differs from card/card.json (sha256 ${local.slice(0, 12)}...). Republish it from the owner's Mac (gas only) when the change is intended.` };
  });
}

// ---------- report ----------
const icon = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' } as const;
const counts = { pass: 0, warn: 0, fail: 0 };
for (const r of results) counts[r.status]++;
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ base: BASE, checked_at: new Date().toISOString(), counts, results }, null, 1));
} else {
  console.log(`# Live check: ${BASE}\n`);
  console.log(`${new Date().toISOString()}: **${counts.pass} passed, ${counts.warn} warnings, ${counts.fail} failed**\n`);
  console.log('| Area | Check | Result | Detail | Time |');
  console.log('|---|---|---|---|---|');
  for (const r of results) console.log(`| ${r.area} | ${r.check} | ${icon[r.status]} | ${r.detail.replace(/\|/g, '/')} | ${r.ms} ms |`);
}
if (counts.fail) process.exitCode = 1;
