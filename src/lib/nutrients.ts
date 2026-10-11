import data from '../../data/nutrients.json' with { type: 'json' };
import { normalizeName } from './text.js';
import type { Nutrient, NutrientsFile } from './types.js';

export interface FormHit {
  nutrient: Nutrient;
  kind: string;
}

/** Lookup tables over data/nutrients.json, all keyed by normalizeName(). */
export class NutrientIndex {
  readonly all: Nutrient[];
  readonly driReviewed: string;
  private readonly byId = new Map<string, Nutrient>();
  private readonly bySynonym = new Map<string, Nutrient>();
  private readonly byGroup = new Map<string, Nutrient>();
  private readonly byUnii = new Map<string, Nutrient>();
  private readonly byForm = new Map<string, FormHit[]>();

  constructor(file: NutrientsFile) {
    this.all = file.nutrients;
    this.driReviewed = file.dri_reviewed;
    for (const n of file.nutrients) {
      this.byId.set(n.id, n);
      for (const s of [n.name, ...n.synonyms]) this.bySynonym.set(normalizeName(s), n);
      for (const g of n.dsld_ingredient_groups) this.byGroup.set(normalizeName(g), n);
      for (const u of n.unii_codes) this.byUnii.set(u.toUpperCase(), n);
      for (const f of n.forms) {
        const key = normalizeName(f.name);
        const hits = this.byForm.get(key) ?? [];
        hits.push({ nutrient: n, kind: f.kind });
        this.byForm.set(key, hits);
      }
    }
  }

  get(id: string): Nutrient | undefined {
    return this.byId.get(id);
  }

  /** Resolve a caller-supplied nutrient: id ("vitamin-d"), name or synonym ("Vitamin D3"). */
  resolve(query: string): Nutrient | undefined {
    const trimmed = query.trim().toLowerCase();
    return this.byId.get(trimmed) ?? this.bySynonym.get(normalizeName(query)) ?? this.byId.get(trimmed.replace(/\s+/g, '-'));
  }

  bySynonymName(name: string): Nutrient | undefined {
    return this.bySynonym.get(normalizeName(name));
  }

  byIngredientGroup(group: string): Nutrient | undefined {
    return this.byGroup.get(normalizeName(group));
  }

  byUniiCode(code: string): Nutrient | undefined {
    return this.byUnii.get(code.trim().toUpperCase());
  }

  formHits(name: string): FormHit[] {
    return this.byForm.get(normalizeName(name)) ?? [];
  }
}

export const nutrientIndex = new NutrientIndex(data as unknown as NutrientsFile);
