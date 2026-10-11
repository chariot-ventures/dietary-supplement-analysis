/**
 * Does a model answer supplement questions better with this service than
 * without it? For each case in eval/cases.json, the same model answers twice:
 *
 *   alone:     the user's question only
 *   with tool: the question plus this service's stack_analyze summary
 *
 * Both answers are scored against the same hand-checked expectations
 * (flags, in-stack interactions, botanical concerns). Needs an Anthropic key:
 *
 *   ANTHROPIC_API_KEY=... npm run eval:llm                  # all cases
 *   ANTHROPIC_API_KEY=... EVAL_MODEL=claude-haiku-5-5 npm run eval:llm -- --limit 10 --write
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { buildApp } from '../src/app.js';
import { matchBotanical } from '../src/lib/botanicals.js';
import { DsldClient } from '../src/lib/dsld.js';
import { createFixtureFetch } from '../src/lib/dsld-fixtures.js';
import { nutrientIndex } from '../src/lib/nutrients.js';
import { CASES, score, type Claims, type EvalCase, type Expect } from './score.js';

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.EVAL_MODEL ?? 'claude-sonnet-5-5';
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg > 0 ? Number(process.argv[limitArg + 1]) : CASES.length;

const INSTRUCTIONS = `Answer as a careful assistant. Then, on the last line, output only a JSON object:
{"above_ul": [nutrients whose total daily intake from the supplements exceeds the NIH Tolerable Upper Intake Level for this person],
 "near_ul": [nutrients at 90-100% of the UL],
 "interactions": [{"with": medication or condition as the user named it, "ingredient": nutrient or herb in their supplements}],
 "herbs_of_concern": [herbs or non-nutrient ingredients in their supplements that NIH warns about, or whose dose is above what NIH cites]}
Use [] when there is nothing. Count only the supplements described, not food.`;

async function ask(prompt: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY!, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 1200, messages: [{ role: 'user', content: prompt }] }),
  });
  const body = (await res.json()) as { content?: { type: string; text?: string }[]; error?: { message: string } };
  if (!res.ok) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  return (body.content ?? []).map((c) => c.text ?? '').join('');
}

/** The question in words, with the profile and products spelled out the way a user would. */
function describe(c: EvalCase): string {
  const r = c.request as { age?: number; sex?: string; life_stage?: string; medications?: string[]; conditions?: string[]; products: { name?: string; servings_per_day?: number; ingredients: { name: string; amount: number; unit: string }[] }[] };
  const prods = r.products.map((p) => `${p.name ?? 'Supplement'}: ${p.ingredients.map((i) => `${i.name} ${i.amount} ${i.unit}`).join(', ')}${p.servings_per_day ? `, ${p.servings_per_day} servings a day` : ', once a day'}`);
  return [
    c.question,
    r.age !== undefined ? `Person: ${r.age} years old, ${r.sex}${r.life_stage ? `, ${r.life_stage}` : ''}.` : 'Age and sex not given.',
    `Supplements: ${prods.join('; ')}.`,
    r.medications ? `Medications: ${r.medications.join(', ')}.` : '',
    r.conditions ? `Conditions: ${r.conditions.join(', ')}.` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function parseClaims(text: string, c: EvalCase): Claims {
  const m = text.match(/\{[\s\S]*\}\s*$/);
  let j: { above_ul?: string[]; near_ul?: string[]; interactions?: { with?: string; ingredient?: string }[]; herbs_of_concern?: string[] } = {};
  try {
    j = m ? JSON.parse(m[0]) : {};
  } catch {
    /* unparseable: scored as claiming nothing */
  }
  const id = (s: string) => nutrientIndex.resolve(s)?.id ?? matchBotanical([s])?.id ?? s.toLowerCase();
  const r = c.request as { medications?: string[]; conditions?: string[] };
  const triggers = [...(r.medications ?? []), ...(r.conditions ?? [])];
  const trigger = (w: string) => triggers.find((t) => t.toLowerCase() === w.toLowerCase() || w.toLowerCase().includes(t.toLowerCase().replace(/_/g, ' '))) ?? (r.conditions?.length === 1 && !r.medications ? r.conditions[0]! : w);
  const herbs = (j.herbs_of_concern ?? []).map(id);
  return {
    above: (j.above_ul ?? []).map(id),
    near: (j.near_ul ?? []).map(id),
    interactions: (j.interactions ?? []).filter((x) => x.with && x.ingredient).map((x) => `${trigger(x.with!)}|${id(x.ingredient!)}`),
    botanicals: herbs,
    dose: herbs,
  };
}

/** What a model can be asked about: flags, interactions, herbs. Amounts and data gaps are service-only checks. */
const llmExpect = (e: Expect): Expect => ({ above: e.above, near: e.near, interactions: e.interactions, no_in_stack: e.no_in_stack, botanicals: e.botanicals, dose: e.dose });

if (!KEY) {
  console.error('Set ANTHROPIC_API_KEY to run the LLM comparison.');
  process.exit(2);
}
const app = buildApp({ dsld: new DsldClient({ fetchImpl: createFixtureFetch(new Map()) }), rxnorm: null });
const rows = [];
for (const c of CASES.slice(0, LIMIT)) {
  const q = describe(c);
  const tool = (await app.inject({ method: 'POST', url: '/v1/stack/analyze', payload: { ...c.request, detail: 'summary' } })).body;
  const [alone, withTool] = await Promise.all([ask(`${q}\n\n${INSTRUCTIONS}`), ask(`${q}\n\nResult from the dietary-supplement-analysis tool (NIH data):\n${tool}\n\n${INSTRUCTIONS}`)]);
  const e = llmExpect(c.expect);
  const a = score(e, parseClaims(alone, c));
  const t = score(e, parseClaims(withTool, c));
  rows.push({ id: c.id, category: c.category, alone: a.length === 0, with_tool: t.length === 0, alone_problems: a, with_tool_problems: t });
  console.log(`${c.id.padEnd(28)} alone ${a.length ? 'FAIL' : 'pass'}  with tool ${t.length ? 'FAIL' : 'pass'}`);
}
await app.close();
const n = rows.length;
const alonePass = rows.filter((r) => r.alone).length;
const toolPass = rows.filter((r) => r.with_tool).length;
console.log(`\n${MODEL}: alone ${alonePass}/${n}, with tool ${toolPass}/${n}`);
if (process.argv.includes('--write')) {
  writeFileSync('eval/llm-results.json', `${JSON.stringify({ model: MODEL, date: new Date().toISOString().slice(0, 10), alone: alonePass, with_tool: toolPass, total: n, rows }, null, 1)}\n`);
  const table = [`${MODEL}, ${new Date().toISOString().slice(0, 10)}: **alone ${alonePass} of ${n}, with this service ${toolPass} of ${n}.**`, '', '| Case | Alone | With tool |', '|---|---|---|', ...rows.map((r) => `| ${r.id} | ${r.alone ? 'pass' : 'fail'} | ${r.with_tool ? 'pass' : 'fail'} |`)].join('\n');
  const md = readFileSync('EVAL.md', 'utf8').replace(/<!-- llm:start -->[\s\S]*<!-- llm:end -->/, `<!-- llm:start -->\n${table}\n<!-- llm:end -->`);
  writeFileSync('EVAL.md', md);
}
