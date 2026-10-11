import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app.js';
import { DsldClient, type DsldClientOptions, type DsldLabel } from '../src/lib/dsld.js';
import { createFixtureFetch, loadFixtureLabels } from '../src/lib/dsld-fixtures.js';
import { normalizeDsldLabel } from '../src/lib/label.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE_DIR = path.join(ROOT, 'test/fixtures/dsld');
export const REAL_FIXTURE_DIR = path.join(FIXTURE_DIR, 'real');
/** Synthetic labels (9000xx) plus real labels recorded from DSLD. */
export const fixtureLabels = new Map([...loadFixtureLabels(FIXTURE_DIR), ...loadFixtureLabels(REAL_FIXTURE_DIR)]);

export function fixtureLabel(id: number): DsldLabel {
  const l = fixtureLabels.get(id);
  if (!l) throw new Error(`no fixture ${id}`);
  return structuredClone(l);
}

export function normalizedFixture(id: number) {
  return normalizeDsldLabel(fixtureLabel(id));
}

export function fixtureClient(opts: DsldClientOptions = {}, onRequest?: (url: string) => void): DsldClient {
  return new DsldClient({ fetchImpl: createFixtureFetch(fixtureLabels, onRequest), ...opts });
}

export function testApp(opts: DsldClientOptions = {}, onRequest?: (url: string) => void) {
  return buildApp({ dsld: fixtureClient(opts, onRequest) });
}

/** Minimal DSLD-shaped label builder for focused tests. */
export function makeLabel(id: number, rows: DsldLabel['ingredientRows'], serving: Partial<NonNullable<DsldLabel['servingSizes']>[number]> = {}): DsldLabel {
  return {
    id,
    fullName: `Test ${id}`,
    brandName: 'Test Brand',
    offMarket: 0,
    servingSizes: [{ order: 1, minQuantity: 1, maxQuantity: 1, minDailyServings: 1, maxDailyServings: 1, unit: 'Capsule(s)', ...serving }],
    ingredientRows: rows,
    statements: [],
  };
}

export function q(amount: number | null, unit: string, servingSizeQuantity = 1) {
  return [{ servingSizeOrder: 1, servingSizeQuantity, quantity: amount, unit }];
}
