export type Sex = 'male' | 'female';
export type DriType = 'rda' | 'ear' | 'ai' | 'ul';

export interface AgeRange {
  /** Inclusive lower age in whole years; null means "from birth". */
  lower: number | null;
  /** Inclusive upper age in whole years; null means "and older". */
  upper: number | null;
  amount: number;
}

export type SexTable = Record<Sex, AgeRange[]>;

export interface DriTables {
  rda: SexTable | null;
  ear: SexTable | null;
  ai: SexTable | null;
  ul: SexTable | null;
}

export interface NutrientForm {
  name: string;
  kind: string;
}

export interface UnitConversion {
  /** Source unit: "IU" or a plain mass unit ("mcg") for nutrients with a basis (RAE, DFE). */
  from: string;
  /** canonical amount = source amount x factor (after converting plain mass to `from`). */
  factor: number;
  /** Form kinds the factor is valid for; "*" means any form. */
  applies_to_forms: string[];
  note?: string;
}

/** Which part of a nutrient's total the UL is compared against. */
export type UlComponent = 'all' | 'preformed' | 'folic_acid';

export interface Nutrient {
  id: string;
  name: string;
  canonical_unit: string;
  synonyms: string[];
  dsld_ingredient_groups: string[];
  unii_codes: string[];
  forms: NutrientForm[];
  unit_conversions: UnitConversion[];
  /** True when a plain mass label unit (e.g. "mg") already equals the canonical basis (mg NE, mg alpha-tocopherol). */
  plain_mass_is_canonical: boolean;
  dri: DriTables | null;
  ul_unit: string | null;
  ul_component: UlComponent;
  ul_scope: string;
  ul_note: string | null;
  factsheet_url: string;
  source_url: string;
}

export interface NutrientsFile {
  _generated: string;
  dri_reviewed: string;
  nutrients: Nutrient[];
}
