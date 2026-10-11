import { describe, expect, it } from 'vitest';
import { lookupReference, lookupValue, rangeMatches, targetIntake } from '../src/lib/dri.js';
import { nutrientIndex } from '../src/lib/nutrients.js';
import type { Nutrient } from '../src/lib/types.js';

const n = (id: string) => nutrientIndex.get(id)!;

describe('rangeMatches', () => {
  it('handles null bounds', () => {
    expect(rangeMatches({ lower: null, upper: 3, amount: 1 }, 0)).toBe(true);
    expect(rangeMatches({ lower: null, upper: 3, amount: 1 }, 4)).toBe(false);
    expect(rangeMatches({ lower: 71, upper: null, amount: 1 }, 110)).toBe(true);
    expect(rangeMatches({ lower: 71, upper: null, amount: 1 }, 70.9)).toBe(false);
  });
  it('uses whole years: 30.9 is in 19-30', () => {
    expect(rangeMatches({ lower: 19, upper: 30, amount: 1 }, 30.9)).toBe(true);
    expect(rangeMatches({ lower: 31, upper: 50, amount: 1 }, 30.9)).toBe(false);
  });
});

describe('lookupReference', () => {
  it('vitamin D for a 34-year-old woman', () => {
    expect(lookupReference(n('vitamin-d'), 34, 'female')).toEqual({ rda: 15, ear: 10, ai: null, ul: 100 });
  });
  it('vitamin D RDA rises at 71', () => {
    expect(lookupValue(n('vitamin-d'), 'rda', 70, 'male')).toBe(15);
    expect(lookupValue(n('vitamin-d'), 'rda', 71, 'male')).toBe(20);
  });
  it('age band edges: magnesium 30 vs 31, 18 vs 19', () => {
    expect(lookupValue(n('magnesium'), 'rda', 30, 'male')).toBe(400);
    expect(lookupValue(n('magnesium'), 'rda', 31, 'male')).toBe(420);
    expect(lookupValue(n('magnesium'), 'rda', 18, 'female')).toBe(360);
    expect(lookupValue(n('magnesium'), 'rda', 19, 'female')).toBe(310);
  });
  it('differs by sex: iron at 30 and at 51', () => {
    expect(lookupValue(n('iron'), 'rda', 30, 'female')).toBe(18);
    expect(lookupValue(n('iron'), 'rda', 30, 'male')).toBe(8);
    expect(lookupValue(n('iron'), 'rda', 51, 'female')).toBe(8);
  });
  it('missing types return null', () => {
    expect(lookupReference(n('vitamin-k'), 40, 'male')).toEqual({ rda: null, ear: null, ai: 120, ul: null });
    expect(lookupReference(n('melatonin'), 40, 'male')).toEqual({ rda: null, ear: null, ai: null, ul: null });
  });
  it('no band matches under 1 year', () => {
    expect(lookupValue(n('vitamin-c'), 'rda', 0.5, 'female')).toBeNull();
  });
  it('handles export-style ranges with null lower bound', () => {
    const fake = {
      ...n('zinc'),
      dri: { rda: { male: [{ lower: null, upper: 13, amount: 5 }, { lower: 14, upper: null, amount: 11 }], female: [] }, ear: null, ai: null, ul: null },
    } satisfies Nutrient;
    expect(lookupValue(fake, 'rda', 2, 'male')).toBe(5);
    expect(lookupValue(fake, 'rda', 80, 'male')).toBe(11);
    expect(lookupValue(fake, 'rda', 80, 'female')).toBeNull();
  });
});

describe('targetIntake', () => {
  it('prefers RDA, falls back to AI', () => {
    expect(targetIntake({ rda: 15, ear: 10, ai: null, ul: 100 })).toEqual({ type: 'rda', amount: 15 });
    expect(targetIntake({ rda: null, ear: null, ai: 90, ul: null })).toEqual({ type: 'ai', amount: 90 });
    expect(targetIntake({ rda: null, ear: null, ai: null, ul: null })).toBeNull();
  });
});
