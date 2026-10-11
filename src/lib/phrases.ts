/**
 * SAGE (Pocket's gateway) scans the raw bytes of every 2xx body, ASCII
 * case-insensitively and without word boundaries, for these phrases. Any hit
 * makes a correct answer count as a failed relay. Phrase table from the Pocket
 * Service Builder skill, references/design-rules.md rule 6 (SAGE @ 224cf05).
 */
export const GATEWAY_PHRASES = [
  // over-servicing
  'offchain rate limit hit by relayer proxy',
  'session relay limit reached',
  'claimable portion fully consumed',
  // chain and data
  'missing trie node',
  'node is unhealthy',
  'block not found',
  'header not found',
  'state not available',
  'pruned state',
  'metadata is not found',
  'historical state',
  'state has been pruned',
  'block has been pruned',
  'is pruned',
  'height is not available',
  'lowest height is',
  "haven't been fully indexed",
  'not been fully indexed',
  'lite fullnode',
  'api is not supported',
  'excluded from account secondary indexes',
  // supplier
  'connection refused',
  'connection reset',
  'timeout',
  'bad gateway',
  'service unavailable',
  'gateway timeout',
] as const;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const PATTERN = new RegExp(GATEWAY_PHRASES.map(escapeRe).join('|'), 'gi');

/**
 * Rewrite serialized JSON so no phrase appears as raw bytes: the first letter
 * of each occurrence becomes a \u escape ("timeout" -> "timeout"), which
 * decodes to the identical string. Phrases contain only letters, spaces and
 * apostrophes, so a match can only sit inside a JSON string value, where a
 * \u escape is always valid.
 */
export function escapeGatewayPhrases(json: string): string {
  let out = json;
  // Loop because escaping one phrase can never create another, but overlapping
  // phrases ("gateway timeout" and "timeout") need a second pass.
  for (let i = 0; i < 3; i++) {
    const next = out.replace(PATTERN, (m) => `\\u${m.charCodeAt(0).toString(16).padStart(4, '0')}${m.slice(1)}`);
    if (next === out) break;
    out = next;
  }
  return out;
}

export function findGatewayPhrase(raw: string): string | undefined {
  const lower = raw.toLowerCase();
  return GATEWAY_PHRASES.find((p) => lower.includes(p));
}
