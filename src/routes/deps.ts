import type { DsldClient } from '../lib/dsld.js';

export interface Deps {
  dsld: DsldClient;
  /** Overall time allowed for upstream DSLD calls in one request (gateways cut relays off at 10-30 s). */
  upstreamBudgetMs?: number;
}

export const DEFAULT_UPSTREAM_BUDGET_MS = 8000;

export function upstreamBudget(deps: Deps): AbortSignal {
  return AbortSignal.timeout(deps.upstreamBudgetMs ?? DEFAULT_UPSTREAM_BUDGET_MS);
}
