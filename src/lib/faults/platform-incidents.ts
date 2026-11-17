/**
 * OPE-1665 — a D1 platform incident is ONE ledger row per burst, not one per
 * SQL statement per route.
 *
 * ── What went wrong ───────────────────────────────────────────────────────
 *
 * The fault key is `route#normalizeErrorClass(message)`, and a D1 failure's
 * message is `Failed query: <the whole statement> params: … cause: D1 DB is
 * overloaded…`. So every distinct statement on every route is its own class:
 * 11-03 → 11-13 the overload bursts minted 2,457 `proposed` rows in 1,453
 * classes across 805 routes for what was a single platform condition, held the
 * OPE-84 candidate list at its 200-row cap for twelve days, and needed a
 * 2,457-row manual `watch` write to clear. Class-level rules (OPE-1174) cannot
 * help, because no class ever accumulates a second row.
 *
 * ── The rule ──────────────────────────────────────────────────────────────
 *
 * When the message carries a known PLATFORM cause, the row is keyed on the
 * cause alone — never on the statement, the route or the source. Rows of one
 * cause that land within `PLATFORM_INCIDENT_GAP_MS` of each other are one burst,
 * and a burst is one row: `d1-platform:<cause>@<first-seen ISO>`, status
 * `watch` (ruled and collapsed, never filed per signature — the OPE-84 gate
 * policy), carrying the burst's hits and its distinct routes and sources.
 * `error_logs` keeps every raw message; only the ledger key changes.
 *
 * The needles are the platform's own phrasing, deliberately narrow: a bare
 * "network connection lost" or "timeout" from OUR code must still mint its own
 * `proposed` row, or platform collapsing would hide a real defect.
 *
 * Identity across scans: the hourly scan re-reads a rolling window capped at
 * its newest rows, so a burst at the window's old edge can lose its first rows
 * and appear to start later. A burst therefore MERGES into an existing row of
 * the same cause whose span it overlaps (± the gap) instead of minting a
 * second key, and counts only ever grow.
 *
 * PURE: no db, no I/O, never throws.
 */

export const PLATFORM_INCIDENT_GAP_MS = 60_000;

export const PLATFORM_SIGNATURE_PREFIX = "d1-platform:";

export type PlatformCause = "overloaded" | "cpu-reset" | "network-lost" | "storage-timeout";

/** Matched against the lowercased message. Real specimens from prod `error_logs`, 2026-11-17. */
export const PLATFORM_CAUSE_SHAPES: ReadonlyArray<{ cause: PlatformCause; needle: string }> = [
  // "D1 DB is overloaded. Too many resources consumed within a 10 second window."
  // "D1 DB is overloaded. Requests queued for too long."
  { cause: "overloaded", needle: "d1 db is overloaded" },
  // "D1_ERROR: D1 DB exceeded its CPU time limit and was reset."
  { cause: "cpu-reset", needle: "d1 db exceeded its cpu time limit" },
  // "cause: D1_ERROR: Network connection lost."
  { cause: "network-lost", needle: "d1_error: network connection lost" },
  // "Durable Object storage operation exceeded timeout which caused object to be reset."
  { cause: "storage-timeout", needle: "storage operation exceeded timeout" },
];

export function platformCause(message: string | null | undefined): PlatformCause | null {
  if (!message) return null;
  const m = message.toLowerCase();
  for (const s of PLATFORM_CAUSE_SHAPES) if (m.includes(s.needle)) return s.cause;
  return null;
}

/** The family key an incident row carries in `error_class`. */
export function platformErrorClass(cause: PlatformCause): string {
  return `${PLATFORM_SIGNATURE_PREFIX}${cause}`;
}

export function platformSignature(cause: PlatformCause, firstSeenMs: number): string {
  return `${platformErrorClass(cause)}@${new Date(firstSeenMs).toISOString()}`;
}

export function isPlatformSignature(signature: string): boolean {
  return signature.startsWith(PLATFORM_SIGNATURE_PREFIX);
}

/** One platform-cause `error_logs` row, already reduced by the emitter. */
export interface PlatformHit {
  cause: PlatformCause;
  tsMs: number;
  /** The emitter's group key for the row (render route, or server source). */
  route: string | null;
  source: string | null;
}

export interface PlatformIncident {
  cause: PlatformCause;
  firstSeen: number;
  lastSeen: number;
  count: number;
  routes: number;
  sources: number;
}

/** Split each cause's hits into bursts wherever consecutive hits are more than `gapMs` apart. */
export function groupPlatformIncidents(
  hits: readonly PlatformHit[],
  gapMs: number = PLATFORM_INCIDENT_GAP_MS
): PlatformIncident[] {
  const byCause = new Map<PlatformCause, PlatformHit[]>();
  for (const h of hits) {
    if (!Number.isFinite(h.tsMs)) continue;
    const list = byCause.get(h.cause) ?? [];
    list.push(h);
    byCause.set(h.cause, list);
  }
  const out: PlatformIncident[] = [];
  for (const [cause, list] of byCause) {
    list.sort((a, b) => a.tsMs - b.tsMs);
    let cur: { first: number; last: number; n: number; r: Set<string>; s: Set<string> } | null =
      null;
    const flush = () => {
      if (cur) {
        out.push({
          cause,
          firstSeen: cur.first,
          lastSeen: cur.last,
          count: cur.n,
          routes: cur.r.size,
          sources: cur.s.size,
        });
      }
    };
    for (const h of list) {
      if (!cur || h.tsMs - cur.last > gapMs) {
        flush();
        cur = { first: h.tsMs, last: h.tsMs, n: 0, r: new Set(), s: new Set() };
      }
      cur.last = h.tsMs;
      cur.n += 1;
      if (h.route) cur.r.add(h.route);
      if (h.source) cur.s.add(h.source);
    }
    flush();
  }
  return out.sort((a, b) => a.firstSeen - b.firstSeen || a.cause.localeCompare(b.cause));
}

/** The ledger fields this reconcile reads. Times are ms-epoch. */
export interface PlatformLedgerRow {
  signature: string;
  firstSeen: number;
  lastSeen: number;
  count: number;
  incidentRoutes: number | null;
  incidentSources: number | null;
}

export type PlatformLedgerOp =
  | {
      op: "insert";
      signature: string;
      errorClass: string;
      firstSeen: number;
      lastSeen: number;
      count: number;
      routes: number;
      sources: number;
    }
  | {
      /** Widen an existing incident row. Never touches its status, ope_id or resolved_at. */
      op: "merge";
      signature: string;
      firstSeen: number;
      lastSeen: number;
      count: number;
      routes: number;
      sources: number;
    };

export function reconcilePlatformIncidents(
  incidents: readonly PlatformIncident[],
  ledger: readonly PlatformLedgerRow[],
  gapMs: number = PLATFORM_INCIDENT_GAP_MS
): PlatformLedgerOp[] {
  // Working copy of the platform rows, so two bursts in one scan that both
  // overlap one row merge into it rather than into stale bounds.
  const rows = ledger.filter((r) => isPlatformSignature(r.signature)).map((r) => ({ ...r }));
  const ops = new Map<string, PlatformLedgerOp>();
  for (const inc of incidents) {
    const prefix = `${platformErrorClass(inc.cause)}@`;
    const hit = rows.find(
      (r) =>
        r.signature.startsWith(prefix) &&
        inc.firstSeen <= r.lastSeen + gapMs &&
        inc.lastSeen >= r.firstSeen - gapMs
    );
    if (hit) {
      hit.firstSeen = Math.min(hit.firstSeen, inc.firstSeen);
      hit.lastSeen = Math.max(hit.lastSeen, inc.lastSeen);
      hit.count = Math.max(hit.count, inc.count);
      hit.incidentRoutes = Math.max(hit.incidentRoutes ?? 0, inc.routes);
      hit.incidentSources = Math.max(hit.incidentSources ?? 0, inc.sources);
      const prior = ops.get(hit.signature);
      if (prior?.op === "insert") {
        ops.set(hit.signature, {
          ...prior,
          firstSeen: hit.firstSeen,
          lastSeen: hit.lastSeen,
          count: hit.count,
          routes: hit.incidentRoutes,
          sources: hit.incidentSources,
        });
      } else {
        ops.set(hit.signature, {
          op: "merge",
          signature: hit.signature,
          firstSeen: hit.firstSeen,
          lastSeen: hit.lastSeen,
          count: hit.count,
          routes: hit.incidentRoutes,
          sources: hit.incidentSources,
        });
      }
      continue;
    }
    const signature = platformSignature(inc.cause, inc.firstSeen);
    rows.push({
      signature,
      firstSeen: inc.firstSeen,
      lastSeen: inc.lastSeen,
      count: inc.count,
      incidentRoutes: inc.routes,
      incidentSources: inc.sources,
    });
    ops.set(signature, {
      op: "insert",
      signature,
      errorClass: platformErrorClass(inc.cause),
      firstSeen: inc.firstSeen,
      lastSeen: inc.lastSeen,
      count: inc.count,
      routes: inc.routes,
      sources: inc.sources,
    });
  }
  return [...ops.values()];
}
