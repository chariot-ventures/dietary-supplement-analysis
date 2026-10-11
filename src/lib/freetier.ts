/**
 * Free trial on the public demo hostname (agents.trackmysupplement.com).
 * Paid Pocket Network relays reach the backend from the relayer under its own
 * host name and are never metered.
 *
 * Daily quotas, reset at 00:00 UTC:
 *   - per MCP connection (Mcp-Session-Id):  25 tool calls   (a person's assistant)
 *   - per client IP, REST calls:           100 calls        (a developer trying it)
 *   - per client IP, MCP tool calls:      1000 calls        (claude.ai and other hosted
 *                                                           clients share a few egress IPs)
 *   - all free traffic:                   5000 calls        (caps the cost of IP rotation)
 * Plus a burst limit of 20 tool calls a minute per MCP connection (per IP when
 * a client sends no session id). Caddy separately limits REST to 30 a minute per IP.
 * Discovery (GET routes, initialize, tools/list) is free and unmetered.
 *
 * Counters are kept in SQLite next to the label store, so redeploys don't
 * reset them. Keys are salted SHA-256 hashes, never raw IPs, and only today's
 * and yesterday's rows are kept.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { FastifyRequest } from 'fastify';

export interface FreeTierLimits {
  perSession: number;
  /** Tool calls per minute per MCP connection. */
  perSessionMinute?: number;
  perIpRest: number;
  perIpMcp: number;
  global: number;
}

export const DEFAULT_LIMITS: FreeTierLimits = { perSession: 25, perSessionMinute: 20, perIpRest: 100, perIpMcp: 1000, global: 5000 };
export const PAID_ROUTE_URL = 'https://github.com/chariot-ventures/dietary-supplement-analysis#through-pocket-network-paid-relay';

type Db = {
  exec(sql: string): void;
  prepare(sql: string): { run(...a: unknown[]): unknown; get(...a: unknown[]): unknown };
  close(): void;
};

export type Scope = 'minute' | 'session' | 'ip' | 'global';
export type Verdict =
  | { ok: true; remaining: number; limit: number; resets_at: string }
  | { ok: false; scope: Scope; limit: number; resets_at: string };

const today = (now: Date) => now.toISOString().slice(0, 10);
const nextMidnight = (now: Date) => `${today(new Date(now.getTime() + 86_400_000))}T00:00:00Z`;

/** IPv4 as is; IPv6 by its /64, since one host usually owns the whole /64. */
export function ipKey(ip: string): string {
  const v4 = ip.replace(/^::ffff:/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) return v4;
  const groups = ip.split('::')[0]!.split(':');
  return `${groups.slice(0, 4).join(':')}::/64`;
}

export class FreeTier {
  private readonly hosts: Set<string>;
  private readonly mem = new Map<string, number>();
  /** Burst window per connection: current minute and calls in it (memory only; a restart just resets it). */
  private readonly minute = new Map<string, { m: number; n: number }>();
  private salt: string;
  private lastPrune = '';

  constructor(
    hosts: string[],
    readonly limits: FreeTierLimits = DEFAULT_LIMITS,
    private readonly db: Db | null = null,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.hosts = new Set(hosts.map((h) => h.trim().toLowerCase()).filter(Boolean));
    this.salt = randomBytes(16).toString('hex');
    if (db) {
      db.exec('CREATE TABLE IF NOT EXISTS usage (day TEXT NOT NULL, key TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, key)); CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
      const row = db.prepare('SELECT v FROM meta WHERE k = ?').get('salt') as { v: string } | undefined;
      if (row) this.salt = row.v;
      else db.prepare('INSERT INTO meta (k, v) VALUES (?, ?)').run('salt', this.salt);
    }
  }

  get enabled(): boolean {
    return this.hosts.size > 0;
  }

  /** True when the request came in on a free-tier hostname. */
  applies(req: FastifyRequest): boolean {
    if (!this.enabled) return false;
    const host = String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
    return this.hosts.has(host);
  }

  /**
   * Client IP as the proxy in front saw it: the last X-Forwarded-For entry, which the
   * proxy appends itself. Earlier entries can be supplied by the caller, so they're ignored.
   */
  clientIp(req: FastifyRequest): string {
    const xff = String(req.headers['x-forwarded-for'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return xff[xff.length - 1] ?? req.ip;
  }

  private hash(s: string): string {
    return createHash('sha256').update(`${this.salt}|${s}`).digest('hex').slice(0, 32);
  }

  private get(day: string, key: string): number {
    if (this.db) return (this.db.prepare('SELECT n FROM usage WHERE day = ? AND key = ?').get(day, key) as { n: number } | undefined)?.n ?? 0;
    return this.mem.get(`${day}|${key}`) ?? 0;
  }

  private bump(day: string, key: string): void {
    if (this.db) this.db.prepare('INSERT INTO usage (day, key, n) VALUES (?, ?, 1) ON CONFLICT (day, key) DO UPDATE SET n = n + 1').run(day, key);
    else this.mem.set(`${day}|${key}`, (this.mem.get(`${day}|${key}`) ?? 0) + 1);
  }

  private prune(day: string): void {
    if (this.lastPrune === day) return;
    this.lastPrune = day;
    const yesterday = today(new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000));
    if (this.db) this.db.prepare('DELETE FROM usage WHERE day < ?').run(yesterday);
    else for (const k of this.mem.keys()) if (k.slice(0, 10) < yesterday) this.mem.delete(k);
  }

  /**
   * Count one call if every applicable quota has room; otherwise refuse
   * without counting. kind "rest" or "mcp"; session only for MCP.
   */
  take(kind: 'rest' | 'mcp', ip: string, session?: string | null): Verdict {
    const now = this.now();
    const day = today(now);
    const resets_at = nextMidnight(now);
    this.prune(day);
    // Burst limit for MCP: per connection, or per address when the client sends no session id.
    const perMin = this.limits.perSessionMinute;
    let burstKey: string | null = null;
    if (kind === 'mcp' && perMin) {
      burstKey = session ? `s:${session}` : `ip:${ipKey(ip)}`;
      const m = Math.floor(now.getTime() / 60_000);
      const w = this.minute.get(burstKey);
      if (w && w.m === m && w.n >= perMin) return { ok: false, scope: 'minute', limit: perMin, resets_at: new Date((m + 1) * 60_000).toISOString().replace('.000Z', 'Z') };
      if (this.minute.size > 50_000) this.minute.clear();
    }
    const checks: { scope: Scope; key: string; limit: number }[] = [{ scope: 'global', key: 'global', limit: this.limits.global }];
    checks.push(kind === 'mcp' ? { scope: 'ip', key: `ipm:${this.hash(ipKey(ip))}`, limit: this.limits.perIpMcp } : { scope: 'ip', key: `ipr:${this.hash(ipKey(ip))}`, limit: this.limits.perIpRest });
    if (kind === 'mcp' && session) checks.push({ scope: 'session', key: `s:${this.hash(session)}`, limit: this.limits.perSession });
    // Most specific first, so the message names the quota the caller can understand.
    checks.reverse();
    const used = checks.map((c) => this.get(day, c.key));
    const full = checks.findIndex((c, i) => used[i]! >= c.limit);
    if (full >= 0) return { ok: false, scope: checks[full]!.scope, limit: checks[full]!.limit, resets_at };
    for (const c of checks) this.bump(day, c.key);
    if (burstKey) {
      const m = Math.floor(now.getTime() / 60_000);
      const w = this.minute.get(burstKey);
      this.minute.set(burstKey, w && w.m === m ? { m, n: w.n + 1 } : { m, n: 1 });
    }
    const remaining = Math.min(...checks.map((c, i) => c.limit - used[i]! - 1));
    return { ok: true, remaining, limit: checks[0]!.limit, resets_at };
  }

  close(): void {
    this.db?.close();
  }
}

/** Plain words an agent can relay when a free quota is used up. */
export function limitMessage(v: Extract<Verdict, { ok: false }>): string {
  if (v.scope === 'minute') {
    return `This connection is calling faster than the free trial allows (${v.limit} checks a minute); it can continue in under a minute. For unlimited use, call the same service through Pocket Network: ${PAID_ROUTE_URL}`;
  }
  const what =
    v.scope === 'session'
      ? `This connection has used its ${v.limit} free checks for today`
      : v.scope === 'ip'
        ? `This network address has used its ${v.limit} free calls for today`
        : "Today's free capacity for this service is used up";
  return `${what}; it resets at ${v.resets_at.slice(11, 16)} UTC (${v.resets_at.slice(0, 10)}). For unlimited use, call the same service through Pocket Network: ${PAID_ROUTE_URL}`;
}

export async function openFreeTier(hosts: string[], limits: FreeTierLimits, file: string | null): Promise<FreeTier> {
  if (!hosts.length || !file) return new FreeTier(hosts, limits, null);
  try {
    const { DatabaseSync } = (await import('node:sqlite')) as unknown as { DatabaseSync: new (p: string) => Db };
    mkdirSync(path.dirname(file), { recursive: true });
    return new FreeTier(hosts, limits, new DatabaseSync(file));
  } catch {
    return new FreeTier(hosts, limits, null);
  }
}
