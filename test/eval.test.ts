import { describe, expect, it } from 'vitest';
import { runServiceEval } from '../eval/run.js';
import { CASES, score } from '../eval/score.js';

describe('hand-checked eval cases', () => {
  it('has unique ids and a reason for every expectation', () => {
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
    for (const c of CASES) expect(c.why.length, c.id).toBeGreaterThan(10);
  });

  it('scoring catches a wrong answer', () => {
    expect(score({ above: ['zinc'], near: [] }, { above: [], near: [], interactions: [] })).toHaveLength(1);
    expect(score({ above: [], near: [], interactions: ['warfarin|vitamin-k'] }, { above: [], near: [], interactions: [] })).toHaveLength(1);
    expect(score({ above: [], near: [], no_in_stack: true }, { above: [], near: [], interactions: ['x|y'] })).toHaveLength(1);
  });

  it('every case passes against the service', async () => {
    const failed = (await runServiceEval()).filter((r) => !r.pass);
    expect(failed).toEqual([]);
  });
});
