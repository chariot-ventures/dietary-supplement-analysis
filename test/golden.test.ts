import { afterAll, describe, expect, it } from 'vitest';
import { testApp } from './helpers.js';

/**
 * Golden snapshot for a 3-product stack. Review any diff in
 * test/golden/stack-3-products.json before committing it
 * (vitest run -u rewrites it).
 */
const app = testApp();
afterAll(() => app.close());

function stableDates(body: unknown): unknown {
  return JSON.parse(JSON.stringify(body).replace(/"(as_of|retrieved)":"\d{4}-\d{2}-\d{2}"/g, '"$1":"<date>"'));
}

describe('golden', () => {
  it('3-product stack for a 34-year-old woman', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/stack/analyze',
      payload: { age: 34, sex: 'female', products: [{ dsld_id: 900001 }, { dsld_id: 900002 }, { dsld_id: 900003 }] },
    });
    expect(res.statusCode).toBe(200);
    await expect(`${JSON.stringify(stableDates(res.json()), null, 2)}\n`).toMatchFileSnapshot('golden/stack-3-products.json');
  });
});
