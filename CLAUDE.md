# Project context for Claude

Pocket Network service `dietary-supplement-analysis`: NIH DSLD supplement labels plus per-nutrient stack totals compared with NIH reference intakes. Built for the Pocket Network Agentic Services Hackathon; submissions are due by midnight EST Monday 2026-10-12.

- **The plan** is [PLAN.md](PLAN.md). Phases 1–4 are done: the service is registered and staked on Beta TestNet and a paid relay has settled (see [deploy/PHASE4_READINESS.md](deploy/PHASE4_READINESS.md)). Later releases are in [CHANGELOG.md](CHANGELOG.md).
- **Releasing:** bump the version (`package.json`, `package-lock.json`, `src/version.ts`, the version tests), run `npm run check`, then push the commit to the `release` branch. The supplier server checks GitHub every 5 minutes and deploys a release branch head whose version is higher than the newest `vX.Y.Z` tag (or the newest tag): see [deploy/autodeploy/](deploy/autodeploy/). Tags also work if you can push them.
- **Republishing the card** (`card/card.json`) on-chain needs the owner key on the owner's Mac: `pocketd tx service add-service ...` from the owner, gas only.
- **Pocket's Service Builder skill** is vendored at `.claude/skills/pocket-service-builder` (v72dd5056ff1f). Use it for every Phase 4 step. The owner is on macOS, so use the command-line (`pocketd`) workflow, not the Windows Pocket Service Manager app.
- **Never spend testnet tokens** (registration, stakes) without the owner's explicit go-ahead. Faucet claims are fine.
- **Keys** stay on the owner's Mac (`pocketd` keyring) and in a mode-0600 secrets file on the VPS. Never commit them, paste them into chat, or put them in an answers file.
- **Server:** Oracle Cloud Always Free ARM VM `150.136.218.205` (Ubuntu 24.04), reached over SSH from Oracle Cloud Shell. Relay endpoint `https://pokt-beta.trackmysupplement.com`, demo route `https://agents.trackmysupplement.com` (rate-limited).

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
