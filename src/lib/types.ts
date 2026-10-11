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
  /** FDA Daily Value used on current labels; lets a plain-mass amount be read in the canonical basis when the label's %DV matches it. */
  label_dv: { amount: number; unit: string } | null;
  /** Pre-2016 FDA Daily Value; only used to recognize the %DV printed on older labels. */
  label_dv_legacy: { amount: number; unit: string } | null;
  /** DSLD ingredient groups in which an exact name match to this nutrient wins over the group's nutrient. */
  name_overrides_groups: string[];
  ul_unit: string | null;
  ul_component: UlComponent;
  ul_scope: string;
  ul_note: string | null;
  /** The adverse effect the UL protects against (the Food and Nutrition Board's critical effect). */
  ul_basis: string | null;
  factsheet_url: string;
  source_url: string;
}

export interface NutrientsFile {
  _generated: string;
  dri_reviewed: string;
  nutrients: Nutrient[];
}
