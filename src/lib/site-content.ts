/**
 * Discovery files for people and agents, served on the public demo host only
 * (src/routes/site.ts): the landing page, llms.txt, llms-full.txt, agents.md,
 * robots.txt, sitemap.xml and ai.txt. Paid relays never reach these routes:
 * on any other host they are 404 JSON, so the gateway rule (every relay body
 * is a JSON object) holds.
 */
import { firstSentence } from './advise.js';
import { GUIDE } from './guide.js';
import { DOCS_URL, SERVICE_ID, VERSION } from '../version.js';

export const SITE_URL = 'https://agents.trackmysupplement.com';
export const MCP_URL = `${SITE_URL}/mcp`;
export const REPO_URL = 'https://github.com/chariot-ventures/dietary-supplement-analysis';
export const CONTACT_EMAIL = 'mb@chariot.ventures';
export const RELAY_URL = 'https://pokt-beta.trackmysupplement.com';
export const AUDIT_URL = `https://mcp.pocketmcp.network/api/audit?network=beta&ids=${SERVICE_ID}`;
export const MCP_REGISTRY_NAME = 'io.github.chariot-ventures/dietary-supplement-analysis';
const TITLE = 'Dietary Supplement Analysis: NIH supplement checks for AI agents';
const TAGLINE =
  'One call checks a person\'s supplements against NIH upper limits, medication and herb interactions and FDA recalls, using the NIH label database, with a citation for every number.';

/** Pocket Network facts shown on the page and in the machine-readable files. */
export const POCKET = {
  service_id: SERVICE_ID,
  network: 'Beta TestNet',
  rpc_type: 'REST',
  compute_units_per_relay: 500,
  relay_endpoint: RELAY_URL,
  mainnet: 'planned',
  agentic_portal: 'not listed yet (the Portal lists MainNet services)',
  audit: AUDIT_URL,
};

/** The official MCP Registry entry (same fields as mcp/server.json, which a test keeps in step). */
export function mcpServerEntry() {
  return {
    $schema: 'https://static.modelcontextprotocol.io/schemas/2025-09-29/server.schema.json',
    name: MCP_REGISTRY_NAME,
    title: 'Dietary Supplement Analysis (NIH data)',
    description: 'NIH supplement checks: upper limits, drug and herb interactions, FDA recalls, with citations.',
    version: VERSION,
    websiteUrl: REPO_URL,
    repository: { url: REPO_URL, source: 'github' },
    remotes: [{ type: 'streamable-http', url: MCP_URL }],
  };
}

export const FREE_TRIAL = { mcp_calls_per_connection_per_day: 25, rest_calls_per_ip_per_day: 100, resets: '00:00 UTC', relays: 'never metered' };

/** Machine-readable files, linked from every page so a crawler finds all of them from any one. */
export const MACHINE_FILES: [string, string][] = [
  ['/llms.txt', 'agent guide (llms.txt)'],
  ['/llms-full.txt', 'guide plus every tool schema'],
  ['/agents.md', 'how agents connect, pay and relay results'],
  ['/openapi.json', 'OpenAPI 3.1'],
  ['/v1/tools', 'tool definitions for function calling'],
  ['/.well-known/mcp.json', 'MCP server entry (registry format)'],
  ['/status.json', 'live status, accuracy and data editions'],
  ['/v1/provenance', 'code commit and data editions behind every answer'],
];

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function connectSnippets(): { client: string; how: string; code: string }[] {
  return [
    { client: 'Claude Code', how: 'Run once in a terminal:', code: `claude mcp add --transport http supplements ${MCP_URL}` },
    { client: 'Claude (claude.ai, desktop, mobile)', how: 'Settings, Connectors, Add custom connector, then paste:', code: MCP_URL },
    { client: 'ChatGPT', how: 'Settings, Apps and Connectors, developer mode, Create, then paste the URL:', code: MCP_URL },
    { client: 'Cursor', how: 'Use the install button, or add to ~/.cursor/mcp.json:', code: JSON.stringify({ mcpServers: { supplements: { url: MCP_URL } } }, null, 2) },
    { client: 'VS Code', how: 'Use the install button, or add to .vscode/mcp.json:', code: JSON.stringify({ servers: { supplements: { type: 'http', url: MCP_URL } } }, null, 2) },
    { client: 'Windsurf', how: 'Add to ~/.codeium/windsurf/mcp_config.json:', code: JSON.stringify({ mcpServers: { supplements: { serverUrl: MCP_URL } } }, null, 2) },
    { client: 'Gemini CLI', how: 'Add to ~/.gemini/settings.json:', code: JSON.stringify({ mcpServers: { supplements: { httpUrl: MCP_URL } } }, null, 2) },
    {
      client: 'OpenAI Agents SDK (Python)',
      how: 'Streamable HTTP MCP server:',
      code: `from agents import Agent\nfrom agents.mcp import MCPServerStreamableHttp\n\nsupplements = MCPServerStreamableHttp(params={"url": "${MCP_URL}"})\nagent = Agent(name="assistant", mcp_servers=[supplements])  # inside: async with supplements: ...`,
    },
    {
      client: 'LangChain / LangGraph (Python)',
      how: 'With langchain-mcp-adapters:',
      code: `from langchain_mcp_adapters.client import MultiServerMCPClient\n\nclient = MultiServerMCPClient({"supplements": {"transport": "streamable_http", "url": "${MCP_URL}"}})\ntools = await client.get_tools()`,
    },
    {
      client: 'CrewAI (Python)',
      how: 'With crewai-tools:',
      code: `from crewai_tools import MCPServerAdapter\n\nwith MCPServerAdapter({"url": "${MCP_URL}", "transport": "streamable-http"}) as tools:\n    ...  # pass tools to your Agent`,
    },
    { client: 'n8n', how: 'Add an "MCP Client Tool" node to your AI Agent, transport HTTP Streamable, endpoint:', code: MCP_URL },
    {
      client: 'Any HTTP client (no MCP)',
      how: 'Plain REST, JSON in and out:',
      code: `curl -s ${SITE_URL}/v1/stack/analyze -H 'Content-Type: application/json' \\\n  -d '{"age":62,"sex":"female","detail":"summary","medications":["warfarin"],"products":[{"query":"Centrum Silver Women 50+"},{"query":"Ginkgo Biloba 120 mg"}]}'`,
    },
    {
      client: 'Pocket Network (paid relay, no quotas)',
      how: 'With an application staked for the service on Beta TestNet and pocket-ap:',
      code: `pocket-ap call --config deploy/beta-stake/pocket-ap.yaml \\\n  --service ${SERVICE_ID} --rpc-type rest \\\n  -X POST --path /v1/stack/analyze \\\n  -d '{"age":34,"sex":"female","products":[{"query":"Nature Made Magnesium 250 mg"}]}'`,
    },
  ];
}

const cursorLink = () => `cursor://anysphere.cursor-deeplink/mcp/install?name=supplements&config=${Buffer.from(JSON.stringify({ url: MCP_URL })).toString('base64')}`;
const vscodeLink = () => `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: 'supplements', type: 'http', url: MCP_URL }))}`;

export const FAQ: [string, string][] = [
  ['Do I need an account or API key?', 'No. The demo host and the remote MCP server need no key. Paid relays go through Pocket Network, where an application stake pays for calls.'],
  ['What does it cost?', `Trying it is free: ${FREE_TRIAL.mcp_calls_per_connection_per_day} MCP tool calls per connection and ${FREE_TRIAL.rest_calls_per_ip_per_day} REST calls per address a day, reset at ${FREE_TRIAL.resets}. Paid relays through Pocket Network cost ${POCKET.compute_units_per_relay} compute units each and have no daily quota.`],
  ['Where does the data come from?', 'Labels from the NIH Dietary Supplement Label Database (the full download, mirrored weekly), reference intakes and interactions from NIH ODS fact sheets, herb warnings from NIH NCCIH fact sheets, recalls and adverse event reports from openFDA, medication names from NIH RxNorm, and foods from USDA. Every number in an answer cites its source, and /v1/provenance gives the exact data editions.'],
  ['How accurate is it?', 'Every release must pass a set of hand-worked cases checked against the NIH tables (see /status.json and EVAL.md), and the live service is tested end to end on a 30-minute schedule. It reports data gaps instead of guessing: an ingredient is never matched by a partial name, and a unit is converted only when its form is unambiguous.'],
  ['Is it medical advice?', 'No. It reports what labels and NIH reference data say, as information. Answers tell the person to check with a doctor or pharmacist before changing anything, and interaction checks are not exhaustive.'],
  ['Which tool should an agent call?', 'stack_analyze (POST /v1/stack/analyze) answers most questions in one call: give the person\'s age, sex, products as they named them, and any medications. Use detail "summary" when the result goes into a model\'s context, and relay agent_summary as written.'],
  ['Who runs it?', `Chariot Ventures. The code is open source under the MIT License. Contact ${CONTACT_EMAIL} or open a GitHub issue.`],
];

function jsonLd(): string {
  const data = [
    {
      '@context': 'https://schema.org',
      '@type': 'WebAPI',
      name: 'Dietary Supplement Analysis',
      alternateName: SERVICE_ID,
      description: TAGLINE,
      url: SITE_URL,
      documentation: `${SITE_URL}/llms.txt`,
      termsOfService: `${REPO_URL}/blob/main/TERMS.md`,
      provider: { '@type': 'Organization', name: 'Chariot Ventures', email: CONTACT_EMAIL, url: REPO_URL },
      softwareVersion: VERSION,
      license: 'https://opensource.org/licenses/MIT',
      isAccessibleForFree: true,
      potentialAction: { '@type': 'ConsumeAction', target: { '@type': 'EntryPoint', urlTemplate: `${SITE_URL}/v1/stack/analyze`, httpMethod: 'POST', contentType: 'application/json' } },
    },
    { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: FAQ.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) },
  ];
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

export function landingPage(tools: { name: string; description: string }[]): string {
  const snippets = connectSnippets();
  const files = MACHINE_FILES.map(([href, label]) => `<li><a href="${href}"><code>${href}</code></a> ${esc(label)}</li>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(TITLE)}</title>
<meta name="description" content="${esc(TAGLINE)}">
<link rel="canonical" href="${SITE_URL}/">
<link rel="alternate" type="text/plain" title="llms.txt" href="/llms.txt">
<link rel="alternate" type="text/markdown" title="agents.md" href="/agents.md">
<link rel="alternate" type="application/json" title="OpenAPI" href="/openapi.json">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23256c4f'/%3E%3Cpath d='M9 17h14M16 10v14' stroke='white' stroke-width='3' stroke-linecap='round'/%3E%3C/svg%3E">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(TITLE)}">
<meta property="og:description" content="${esc(TAGLINE)}">
<meta property="og:url" content="${SITE_URL}/">
<meta name="twitter:card" content="summary">
<script type="application/ld+json">${jsonLd()}</script>
<style>
:root{--bg:#fbfaf7;--fg:#1d2420;--muted:#5b655f;--card:#fff;--line:#e3e1da;--accent:#256c4f;--accent-fg:#fff;--code:#f2f0ea}
@media (prefers-color-scheme:dark){:root{--bg:#121513;--fg:#e8ece9;--muted:#9aa59e;--card:#1a1e1b;--line:#2c322e;--accent:#5cc497;--accent-fg:#0d1210;--code:#202521}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:920px;margin:0 auto;padding:32px 16px 64px}h1{font-size:clamp(1.6rem,4vw,2.2rem);line-height:1.2;margin:0 0 12px}
h2{font-size:1.25rem;margin:40px 0 12px}h3{font-size:1rem;margin:0 0 6px}p{margin:0 0 12px}a{color:var(--accent)}
.lead{font-size:1.1rem;color:var(--muted);max-width:60ch}.row{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0}
.btn{display:inline-block;padding:9px 14px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);text-decoration:none;font-weight:600;font-size:.95rem}
.btn.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;min-width:0}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85rem}pre{background:var(--code);border-radius:8px;padding:10px 12px;overflow-x:auto;margin:6px 0 0;white-space:pre}
:not(pre)>code{background:var(--code);padding:1px 5px;border-radius:4px;overflow-wrap:anywhere}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:0}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
.muted{color:var(--muted)}.small{font-size:.9rem}ul{padding-left:20px}details{border-top:1px solid var(--line);padding:10px 0}summary{cursor:pointer;font-weight:600}
.copy{float:right;font-size:.8rem;padding:2px 8px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
textarea{width:100%;min-height:150px;font:inherit;font-family:ui-monospace,monospace;font-size:.85rem;background:var(--code);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:10px}
#out{white-space:pre-wrap}.status{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--muted);margin-right:6px}.status.ok{background:#2fa36b}
footer{margin-top:48px;border-top:1px solid var(--line);padding-top:16px}
</style>
</head>
<body>
<main>
<p class="small muted"><span class="status" id="dot"></span><span id="live">Version ${VERSION}</span></p>
<h1>NIH supplement checks for AI agents</h1>
<p class="lead">${esc(TAGLINE)}</p>
<div class="row">
<a class="btn primary" href="#connect">Connect an agent</a>
<a class="btn" href="${cursorLink()}">Install in Cursor</a>
<a class="btn" href="${vscodeLink()}">Install in VS Code</a>
<a class="btn" href="/llms.txt">llms.txt</a>
<a class="btn" href="/openapi.json">OpenAPI</a>
</div>
<div class="card"><h3>Remote MCP server (no install, no key)</h3><button class="copy" data-copy="${MCP_URL}">Copy</button><code>${MCP_URL}</code></div>

<h2>What an agent gets in one call</h2>
<div class="grid">
<div class="card"><h3>Upper-limit check</h3><p class="small">Daily totals for every vitamin and mineral across all the person's products, against the NIH upper limit for their age, sex, pregnancy or breastfeeding, with what each limit protects against.</p></div>
<div class="card"><h3>A fix, not just a flag</h3><p class="small">Single-product changes that bring an over-limit nutrient back under it, and the effect of a product the person is thinking of adding.</p></div>
<div class="card"><h3>Medications and herbs</h3><p class="small">Interactions NIH lists for the person's medications (brand or generic, English or Spanish), with timing advice, plus NIH warnings for 24 herbs and other non-nutrients.</p></div>
<div class="card"><h3>Labels and recalls</h3><p class="small">Products found by name or barcode in the NIH label database (214,000+ labels), FDA recalls and adverse event report counts.</p></div>
</div>
<p class="small muted">The answer starts with <code>agent_summary</code>: plain sentences an agent can relay as written, in English or Spanish. Every number cites its NIH or USDA source.</p>

<h2>Try it</h2>
<p class="small">This sends the request below from your browser to the free demo endpoint and shows <code>agent_summary</code>.</p>
<textarea id="req" aria-label="Request body">{"age": 62, "sex": "female", "detail": "summary",
 "medications": ["warfarin"],
 "products": [{"query": "Centrum Silver Women 50+"},
              {"query": "Ginkgo Biloba 120 mg"},
              {"name": "Zinc", "ingredients": [{"name": "zinc", "amount": 50, "unit": "mg"}]}]}</textarea>
<div class="row"><button class="btn primary" id="run">Run stack_analyze</button></div>
<pre id="out" class="card" hidden></pre>

<h2 id="connect">Connect</h2>
${snippets.map((s) => `<details><summary>${esc(s.client)}</summary><p class="small">${esc(s.how)}</p><button class="copy" data-copy="${esc(s.code)}">Copy</button><pre><code>${esc(s.code)}</code></pre></details>`).join('\n')}

<h2>Tools</h2>
<div class="grid">${tools.map((t) => `<div class="card"><h3><code>${esc(t.name)}</code></h3><p class="small">${esc(firstSentence(t.description))}</p></div>`).join('')}</div>

<h2>Pricing and limits</h2>
<div class="grid">
<div class="card"><h3>Free trial</h3><p class="small">${FREE_TRIAL.mcp_calls_per_connection_per_day} MCP tool calls per connection and ${FREE_TRIAL.rest_calls_per_ip_per_day} REST calls per address a day on this host, reset at ${FREE_TRIAL.resets}. Discovery (tool lists, guides, this page) is never counted. What's left is in the <code>X-Free-Tier-Remaining</code> header and in MCP <code>_meta.free_tier</code>.</p></div>
<div class="card"><h3>Pocket Network relays</h3><p class="small">${POCKET.compute_units_per_relay} compute units per relay, paid from an application stake, with no daily quota. Signed relays are served by a staked supplier at <code>${RELAY_URL}</code>.</p></div>
</div>

<h2>On Pocket Network</h2>
<div class="card"><dl>
<dt>Service ID</dt><dd><code>${SERVICE_ID}</code></dd>
<dt>Network</dt><dd>${POCKET.network} (MainNet ${POCKET.mainnet})</dd>
<dt>RPC type</dt><dd>${POCKET.rpc_type}</dd>
<dt>Price</dt><dd>${POCKET.compute_units_per_relay} compute units per relay</dd>
<dt>Relay endpoint</dt><dd><code>${RELAY_URL}</code></dd>
<dt>Portal audit</dt><dd><a href="${AUDIT_URL}">live A1-A9 result</a></dd>
<dt>Agentic Portal</dt><dd>${esc(POCKET.agentic_portal)}</dd>
<dt>Card</dt><dd><a href="${REPO_URL}/blob/release/card/card.json">card/card.json</a></dd>
</dl></div>

<h2>Proof it works</h2>
<div class="card" id="proof"><p class="small">Live status, the accuracy result of this release and the data editions behind every answer: <a href="/status.json">/status.json</a>.</p></div>

<h2>Questions</h2>
${FAQ.map(([q, a]) => `<details><summary>${esc(q)}</summary><p class="small">${esc(a)}</p></details>`).join('\n')}

<h2>For crawlers and agents</h2>
<ul class="small">${files}</ul>
<p class="small muted">Listed in the <a href="https://registry.modelcontextprotocol.io/v0/servers?search=${SERVICE_ID}">official MCP Registry</a> as <code>${MCP_REGISTRY_NAME}</code>.</p>

<footer class="small muted">
<p>Information from supplement labels and NIH reference data, not medical advice. Results can be wrong; check with a doctor or pharmacist before changing supplements or medications. In an emergency call 911; Poison Control 1-800-222-1222.</p>
<p><a href="${REPO_URL}">Source (MIT)</a> · <a href="${REPO_URL}/blob/main/TERMS.md">Terms</a> · <a href="${REPO_URL}/blob/main/EVAL.md">Accuracy</a> · <a href="${REPO_URL}/blob/main/CHANGELOG.md">Changelog</a> · <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a> · <a href="${REPO_URL}/issues">Issues</a></p>
</footer>
</main>
<script>
document.querySelectorAll('[data-copy]').forEach(function(b){b.addEventListener('click',function(){navigator.clipboard.writeText(b.getAttribute('data-copy')).then(function(){b.textContent='Copied';setTimeout(function(){b.textContent='Copy'},1500)})})});
var out=document.getElementById('out');
document.getElementById('run').addEventListener('click',function(){
  var body;try{body=JSON.parse(document.getElementById('req').value)}catch(e){out.hidden=false;out.textContent='The request is not valid JSON.';return}
  out.hidden=false;out.textContent='Running...';
  fetch('/v1/stack/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json()}).then(function(j){out.textContent=j.agent_summary||(j.error&&j.error.message)||JSON.stringify(j,null,2)}).catch(function(){out.textContent='The request failed. Try again in a moment.'});
});
fetch('/status.json').then(function(r){return r.json()}).then(function(s){
  if(s.status==='ok'){document.getElementById('dot').className='status ok'}
  var proof=document.getElementById('proof');var items=[];
  if(s.accuracy){items.push('Accuracy: '+s.accuracy.passed+' of '+s.accuracy.total+' hand-worked NIH cases pass (release '+s.accuracy.service_version+')')}
  if(s.data&&s.data.labels_in_store){items.push('Label data: '+s.data.labels_in_store.toLocaleString()+' NIH labels mirrored, NIH edition '+s.data.nih_label_edition)}
  if(s.data){items.push('Reference values reviewed: '+s.data.reference_values_reviewed)}
  items.push('Up since '+new Date(s.started_at).toUTCString()+(s.commit?', commit '+s.commit.slice(0,7):''));
  var ul=document.createElement('ul');ul.className='small';items.forEach(function(t){var li=document.createElement('li');li.textContent=t;ul.appendChild(li)});proof.insertBefore(ul,proof.firstChild);
  document.getElementById('live').textContent='Live: version '+s.version+(s.accuracy?' · accuracy cases '+s.accuracy.passed+'/'+s.accuracy.total:'')+(s.data&&s.data.labels_in_store?' · '+s.data.labels_in_store.toLocaleString()+' NIH labels':'');
}).catch(function(){});
</script>
</body>
</html>
`;
}

export function agentsMd(): string {
  return `# ${SERVICE_ID} for agents

${TAGLINE}

Version ${VERSION}. Information from labels and NIH reference data, not medical advice.

## Connect

- Remote MCP server (Streamable HTTP, no key): ${MCP_URL}
- REST, JSON in and out: ${SITE_URL}/v1/... (OpenAPI 3.1 at ${SITE_URL}/openapi.json)
- Tool definitions for function calling: ${SITE_URL}/v1/tools
- Pocket Network relays (no quotas): service \`${SERVICE_ID}\` on ${POCKET.network}, rpc_type ${POCKET.rpc_type}, ${POCKET.compute_units_per_relay} compute units per relay, supplier ${RELAY_URL}

${connectSnippets()
  .map((s) => `### ${s.client}\n\n${s.how}\n\n\`\`\`\n${s.code}\n\`\`\``)
  .join('\n\n')}

## Which tool

- \`stack_analyze\` answers most questions in one call. Send the person's age and sex, products as they named them (\`{"query": "..."}\`), barcodes (\`{"upc": "..."}\`) or ingredient lists, and any medications and conditions. Use \`"detail": "summary"\` when the result goes into your context.
- \`interactions_check\`: what NIH lists for a medication or condition, without a stack.
- \`products_search\`, \`products_lookup\` (barcode), \`products_get\`: NIH label data.
- \`products_fda_reports\`: FDA recalls and adverse event report counts for a product.
- \`nutrients_reference\`: RDA, AI and upper limit for an age and sex. Offline.

## Relaying results

- Relay \`agent_summary\` as written, including its last sentence (check with a doctor or pharmacist before changing anything).
- Totals cover the listed supplements only, not food or medications, unless \`foods\` or \`"diet": "typical"\` was given.
- If a product resolved with low confidence, confirm it with the person and re-run with its \`dsld_id\`.
- \`data_gaps[]\` lists what could not be counted; mention gaps that matter instead of guessing.
- Never describe a stack as "safe" or "risk-free": the service reports what NIH data says, and its interaction checks are not exhaustive.

## Limits and errors

- Free trial on ${SITE_URL}: ${FREE_TRIAL.mcp_calls_per_connection_per_day} MCP tool calls per connection and ${FREE_TRIAL.rest_calls_per_ip_per_day} REST calls per address a day, reset at ${FREE_TRIAL.resets}. Pocket Network relays are ${FREE_TRIAL.relays}.
- Every response is a JSON object. Errors are 4xx with \`{"error": {"code", "message", "retryable", "field"}}\`; 429 RATE_LIMITED carries the reset time. Never 5xx.

## Trust

- Live status, accuracy result and data editions: ${SITE_URL}/status.json
- Code commit and data editions behind every answer: ${SITE_URL}/v1/provenance
- Source (MIT): ${REPO_URL}. Terms: ${REPO_URL}/blob/main/TERMS.md
- Contact: ${CONTACT_EMAIL}

Full guide: ${SITE_URL}/llms.txt
`;
}

/** llms.txt: the agent guide with the site's links on top (the same guide is in the repository and at GET /v1/guide). */
export function llmsTxt(): string {
  return `${GUIDE.trimEnd()}

## Links

- Remote MCP server (no key): ${MCP_URL}
- How agents connect, pay and relay results: ${SITE_URL}/agents.md
- Guide plus every tool schema: ${SITE_URL}/llms-full.txt
- OpenAPI 3.1: ${SITE_URL}/openapi.json
- Live status, accuracy and data editions: ${SITE_URL}/status.json
- Pocket Network: service ${SERVICE_ID}, ${POCKET.network}, relay endpoint ${RELAY_URL}
- Source and docs: ${DOCS_URL}
- Contact: ${CONTACT_EMAIL}
`;
}

export function llmsFullTxt(tools: { name: string; description: string; path?: string; input_schema: unknown }[]): string {
  return `${llmsTxt()}
## Tool schemas

${tools.map((t) => `### ${t.name}${t.path ? ` (POST ${t.path})` : ''}\n\n${t.description}\n\n\`\`\`json\n${JSON.stringify(t.input_schema, null, 2)}\n\`\`\``).join('\n\n')}
`;
}

export function robotsTxt(): string {
  return `# Crawlers and AI agents are welcome. API calls are metered on this host; see /agents.md.
User-agent: *
Allow: /
Disallow: /mcp

Sitemap: ${SITE_URL}/sitemap.xml
`;
}

export function aiTxt(): string {
  return `# ai.txt for ${SITE_URL}
# AI crawlers, assistants and agents may read, index and cite every page and file here, and may use the API
# within its terms: ${REPO_URL}/blob/main/TERMS.md
User-Agent: *
Allow: /
Agent-Guide: ${SITE_URL}/llms.txt
MCP: ${MCP_URL}
Contact: ${CONTACT_EMAIL}
`;
}

export function sitemapXml(): string {
  const paths = ['/', '/llms.txt', '/llms-full.txt', '/agents.md', '/openapi.json', '/status.json'];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paths.map((p) => `  <url><loc>${SITE_URL}${p}</loc></url>`).join('\n')}
</urlset>
`;
}
