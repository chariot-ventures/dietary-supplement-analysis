# Project context for Claude

Pocket Network service `dietary-supplement-analysis`: NIH DSLD supplement labels plus per-nutrient stack totals compared with NIH reference intakes. Built for the Pocket Network Agentic Services Hackathon; submissions are due by midnight EST Monday 2026-10-12.

- **The plan** is [PLAN.md](PLAN.md). Phases 1–3 are done and tagged `v0.1.0`. Phase 4 (Beta TestNet deployment) is next; read [deploy/PHASE4_READINESS.md](deploy/PHASE4_READINESS.md) first.
- **Pocket's Service Builder skill** is vendored at `.claude/skills/pocket-service-builder` (v72dd5056ff1f). Use it for every Phase 4 step. The owner is on macOS, so use the command-line (`pocketd`) workflow, not the Windows Pocket Service Manager app.
- **Never spend testnet tokens** (registration, stakes) without the owner's explicit go-ahead. Faucet claims are fine.
- **Keys** stay on the owner's Mac (`pocketd` keyring) and in a mode-0600 secrets file on the VPS. Never commit them, paste them into chat, or put them in an answers file.
- **Open owner tasks:**
  - Make the GitHub repo public.
  - Check the DRI values in `data/source/manual.json` against the NIH ODS fact sheets. ods.od.nih.gov blocks automated clients, so use a real browser.
  - Provide a VPS provider account and a domain.

## Commands

```bash
npm ci
npm run check            # nutrients.json + openapi.json freshness, eslint, tsc, vitest
npm run build && npm start
DSLD_FIXTURES_DIR=test/fixtures/dsld/real npm run dev   # offline, 12 real recorded labels
npx tsx scripts/record-fixtures.ts <dsld_id...>          # record more real labels
```

- After editing `data/source/manual.json`, run `npm run build:nutrients`.
- After changing request schemas or `src/openapi.ts`, run `npm run build:openapi`.

## Rules the code depends on

- **Gateway response rules:** every response is a JSON object, client errors are 4xx, nothing is ever 5xx, and there's no compression. Gateway error phrases are `\u`-escaped by the reply serializer (`src/lib/phrases.ts`).
- **Logging:** never log request bodies or query strings.
- **Data gaps over guesses:** no substring or fuzzy ingredient matching. A unit is converted only when its form is unambiguous.
- **Wording:** never say a stack is "safe" or carries "no risk".
