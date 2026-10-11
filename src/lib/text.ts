/**
 * Normalize an ingredient, form or synonym name for exact matching:
 * lowercase, drop trademark symbols and bracketed qualifiers' punctuation,
 * treat hyphens, commas, slashes and parentheses as spaces, collapse whitespace.
 * "D-Alpha Tocopheryl Acetate" and "d-alpha-tocopheryl acetate" both become
 * "d alpha tocopheryl acetate".
 */
export function normalizeName(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[®™©*†‡]/g, '')
    .replace(/[‐‑‒–—―-]/g, ' ')
    .replace(/[(),/\\:;[\]{}"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Round to at most `digits` decimals, avoiding float noise like 0.30000000000000004. */
export function round(value: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round((value + Number.EPSILON) * f) / f;
}

export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
