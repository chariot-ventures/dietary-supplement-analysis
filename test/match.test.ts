import { describe, expect, it } from 'vitest';
import { matchIngredient } from '../src/lib/match.js';
import { NutrientIndex, nutrientIndex } from '../src/lib/nutrients.js';

describe('matchIngredient', () => {
  it('matches by DSLD ingredientGroup first', () => {
    const m = matchIngredient({ name: 'Vitamin D3 (as cholecalciferol)', ingredientGroup: 'Vitamin D' });
    expect(m).toMatchObject({ nutrient: { id: 'vitamin-d' }, matched_by: 'ingredient_group' });
  });

  it('matches exact synonyms case- and punctuation-insensitively', () => {
    expect(matchIngredient({ name: 'Cholecalciferol' })?.nutrient.id).toBe('vitamin-d');
    expect(matchIngredient({ name: 'VITAMIN B-12' })).toBeNull(); // "vitamin b 12" is not a synonym
    expect(matchIngredient({ name: 'Vitamin B12' })?.nutrient.id).toBe('vitamin-b12');
  });

  it('never matches by substring', () => {
    expect(matchIngredient({ name: 'Vitamin B' })).toBeNull();
    expect(matchIngredient({ name: 'Vitamin B Complex' })).toBeNull();
    expect(matchIngredient({ name: 'Magnesium Stearate Blend' })).toBeNull();
  });

  it('matches by UNII code when one is known', () => {
    // unii_codes are empty until recorded from real DSLD labels; use a private index.
    const vitC = { ...structuredClone(nutrientIndex.get('vitamin-c')!), unii_codes: ['PQ6CK8PD0R'] };
    const idx = new NutrientIndex({ _generated: '', dri_reviewed: '', nutrients: [vitC] });
    expect(matchIngredient({ name: 'Unlabelled acid', uniiCode: 'pq6ck8pd0r' }, idx)?.matched_by).toBe('unii');
  });

  it('matches a form name owned by exactly one nutrient, and flags compounds', () => {
    const m = matchIngredient({ name: 'Magnesium Glycinate' });
    expect(m).toMatchObject({ nutrient: { id: 'magnesium' }, matched_by: 'form', name_is_compound: true });
  });

  it('does not guess when a form name belongs to several nutrients', () => {
    expect(matchIngredient({ name: 'Dicalcium Phosphate' })).toBeNull();
  });

  it('detects form kinds from forms and alternate names', () => {
    expect(matchIngredient({ name: 'Folate', forms: [{ name: 'Folic Acid' }] })?.form_kind).toBe('folic_acid');
    expect(matchIngredient({ name: 'Folate', forms: [{ name: 'L-5-Methyltetrahydrofolate' }] })?.form_kind).toBe('other_folate');
    expect(matchIngredient({ name: 'Vitamin E', forms: [{ name: 'd-Alpha Tocopheryl Succinate' }] })?.form_kind).toBe('natural');
    const mixed = matchIngredient({ name: 'Vitamin A', forms: [{ name: 'Retinyl Palmitate' }, { name: 'Beta Carotene' }] });
    expect(mixed).toMatchObject({ form_kind: null, mixed_forms: true });
  });

  it('a mineral row named for the element is not a compound', () => {
    expect(matchIngredient({ name: 'Magnesium', forms: [{ name: 'Magnesium Oxide' }] })?.name_is_compound).toBe(false);
  });

  it('standalone beta-carotene is its own entry, not vitamin A', () => {
    expect(matchIngredient({ name: 'Beta-Carotene' })?.nutrient.id).toBe('beta-carotene');
  });
});
