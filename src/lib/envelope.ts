import { SERVICE_ID, VERSION } from '../version.js';
import { todayIso } from './text.js';

export const DISCLAIMER =
  'Information only, not medical advice, and not a substitute for a doctor or pharmacist; not intended to diagnose, treat, cure or prevent any disease. Labels and public data can be wrong or out of date. Check with a health professional before changing supplements or medications. In an emergency, call 911 or Poison Control (1-800-222-1222) in the US. Terms: https://github.com/chariot-ventures/dietary-supplement-analysis/blob/main/TERMS.md';

export interface Source {
  name: string;
  url: string;
  retrieved: string;
}

/**
 * Common response wrapper. Short metadata first, endpoint fields next,
 * then sources and the disclaimer (gateways read the first bytes).
 */
export function envelope<T extends object>(fields: T, sources: Source[]): { service: string; version: string; as_of: string } & T & { sources: Source[]; disclaimer: string } {
  return { service: SERVICE_ID, version: VERSION, as_of: todayIso(), ...fields, sources: dedupeSources(sources), disclaimer: DISCLAIMER };
}

export function dedupeSources(sources: Source[]): Source[] {
  const seen = new Set<string>();
  return sources.filter((s) => (seen.has(s.url) ? false : (seen.add(s.url), true)));
}

export function factsheetSource(name: string, url: string, reviewed: string): Source {
  return { name: `NIH Office of Dietary Supplements: ${name} fact sheet`, url, retrieved: reviewed };
}

export function dsldSource(url: string, retrieved: string): Source {
  return { name: 'NIH Dietary Supplement Label Database', url, retrieved };
}
