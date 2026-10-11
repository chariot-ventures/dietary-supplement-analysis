/**
 * Where every answer comes from: code version and commit, and the date or
 * edition of each data source. Small enough to include in every analysis, so
 * an agent can cite and reproduce an answer exactly.
 */
import { DIET_SOURCE } from './diet.js';
import { nutrientIndex } from './nutrients.js';
import { DOCS_URL, SERVICE_ID, VERSION } from '../version.js';

/** Set at image build time (Docker build arg GIT_COMMIT); null in development. */
export const GIT_COMMIT: string | null = process.env.GIT_COMMIT && /^[0-9a-f]{7,40}$/.test(process.env.GIT_COMMIT) ? process.env.GIT_COMMIT : null;

/** Optional: the label store, to report the mirrored NIH dump. */
interface MetaReader {
  getMeta(k: string): string | null;
  count(): number;
}

function mirrorInfo(store: MetaReader | null | undefined) {
  try {
    const version = store?.getMeta('mirror_version') ?? null;
    if (!store || !version) return null;
    return { source: 'NIH DSLD full-database JSON download', version, imported_at: store.getMeta('mirror_imported_at'), labels_in_store: store.count() };
  } catch {
    return null;
  }
}

export function provenance(store?: MetaReader | null) {
  return {
    service: SERVICE_ID,
    version: VERSION,
    commit: GIT_COMMIT,
    source_code: GIT_COMMIT ? `https://github.com/micallb/dietary-supplement-analysis/tree/${GIT_COMMIT}` : DOCS_URL,
    data: {
      reference_values: { name: 'Food and Nutrition Board DRIs via NIH ODS fact sheets', reviewed: nutrientIndex.driReviewed },
      labels: {
        name: 'NIH Dietary Supplement Label Database (DSLD): full-database download mirrored locally, API v9 for newer labels',
        retrieved: 'per label, see sources[].retrieved',
        mirror: mirrorInfo(store),
      },
      foods: { name: 'USDA National Nutrient Database for Standard Reference, Release 28 (SR Legacy)', retrieved: '2026-10-11' },
      typical_intake: { name: DIET_SOURCE.name, retrieved: DIET_SOURCE.retrieved },
    },
  };
}

/** The short form included in every analysis response. */
export function provenanceShort() {
  return { version: VERSION, commit: GIT_COMMIT, reference_values_reviewed: nutrientIndex.driReviewed };
}
