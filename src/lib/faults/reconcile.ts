/**
 * OPE-81 — the pure reconcile core for the render-fault detect→group→dedup→emit
 * rail: turn grouped `error_logs` faults into ONE unit of work per fault.
 *
 * ── Why a RAIL and not a cron that files directly ─────────────────────────────
 * Same shape as OPE-76 (CPI auto-file): a Cloudflare Worker CANNOT call the Linear
 * MCP `save_issue` (an agent-session tool) and there is NO Linear API token in this
 * codebase. So the developer builds the RAIL that makes safe auto-filing possible —
 * this threshold + dedup + regression ledger — and a scheduled analyst agent run
 * does the actual filing.
 *
 * ── Agent handoff (companion work, NOT this PR) ───────────────────────────────
 * A scheduled agent run (analyst-claude-desktop):
 *   1. POSTs /api/internal/faults/candidates (X-Internal-Key). The endpoint reads
 *      `error_logs`, drops noise (isNoise), groups by computeSignature, runs this
 *      reconcile core, APPLIES the upserts, and returns { toEmit, existing,
 *      regressions, deferred }.
 *   2. For each `toEmit` / `regressions` candidate: files ONE OPE via Linear
 *      `save_issue`, embedding `faultSigToken(signature)` in the OPE body (its own
 *      Linear dup pre-flight) so a recurring fault can't be double-filed.
 *   3. POSTs /api/internal/faults/record-candidate { signature, opeId, status } so
 *      the next scan sees the row as 'filed' (not re-emitted); 'done' closes it.
 *   4. Ignores `existing` (already known / already flagged — no new work).
 * `deferred` candidates are batch-cap overflow: already persisted 'proposed' (or
 * 'regressed'), so they emit on the next run — a flapping fault can't spam Linear.
 *
 * This module is PURE (no db, no I/O) and never throws (guards unparseable input).
 */

/** A signature must clear EITHER gate to be eligible: enough occurrences OR
 * enough distinct sessions. One-offs below both self-suppress. */
export const DEFAULT_MIN_COUNT = 3;
export const DEFAULT_MIN_SESSIONS = 2;
/** NEW/regression candidates emitted per run — the flap guard (batch cap). */
export const DEFAULT_BATCH_CAP = 5;

export type FaultStatus = "proposed" | "filed" | "done" | "regressed";

/** One grouped fault for a scan window. Times are ms-epoch numbers. */
export interface GroupedFault {
  signature: string;
  route: string | null;
  errorClass: string;
  /** Occurrences in this scan window. */
  count: number;
  /** Distinct sessions in this scan window (falls back to count upstream). */
  distinctSessions: number;
  firstSeen: number;
  lastSeen: number;
}

/** A ledger row, times as ms-epoch numbers (the endpoint maps Date ↔ number). */
export interface FaultLedgerRow {
  signature: string;
  route: string | null;
  errorClass: string;
  firstSeen: number;
  lastSeen: number;
  count: number;
  status: FaultStatus;
  opeId: string | null;
  filedAt: number | null;
  resolvedAt: number | null;
  createdAt: number;
}

/** A fault ready for the agent to file. `kind` distinguishes a first-time fault
 * from one that recurred after being marked done. Times are ms-epoch numbers. */
export interface FaultCandidate {
  signature: string;
  route: string | null;
  errorClass: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  token: string;
  kind: "new" | "regression";
}

/**
 * A ledger mutation the endpoint applies. Times are ms-epoch numbers.
 *   - propose: insert a NEW 'proposed' row (createdAt=now).
 *   - touch:   bump last_seen + count on a still-active row (no status change).
 *   - regress: flip a 'done' row to 'regressed' and bump last_seen + count.
 */
export type LedgerUpsert =
  | {
      op: "propose";
      signature: string;
      route: string | null;
      errorClass: string;
      firstSeen: number;
      lastSeen: number;
      count: number;
      createdAt: number;
    }
  | { op: "touch"; signature: string; lastSeen: number; count: number }
  | { op: "regress"; signature: string; lastSeen: number; count: number };

export interface ReconcileFaultsResult {
  /** NEW faults to file this run (within the batch cap). */
  toEmit: FaultCandidate[];
  /** Already proposed/filed/regressed and still present — no new work. */
  existing: FaultLedgerRow[];
  /** Faults that recurred after being marked done (within the batch cap). */
  regressions: FaultCandidate[];
  /** New/regression candidates over the cap — persisted, emit next run. */
  deferred: FaultCandidate[];
  /** The ledger mutations the endpoint should apply. */
  upserts: LedgerUpsert[];
}

/** faultSigToken inlined (avoids a cross-module dep in the pure core). */
function tokenFor(signature: string): string {
  return `fault-sig:${signature}`;
}

/** A finite number, or the fallback — guards NaN/Infinity from bad input. */
function safeNum(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Reconcile the grouped faults against the ledger. PURE, never throws.
 *
 * Threshold gate: a signature is eligible only if
 *   `count >= minCount || distinctSessions >= minSessions`.
 * Sub-threshold AND not in the ledger → ignored entirely (one-offs self-suppress).
 * Sub-threshold BUT already in the ledger → still `touch`ed (never dropped).
 *
 * Per signature:
 *   - not in ledger + eligible → NEW candidate (`kind:"new"`) + `propose`.
 *   - in ledger, 'proposed'/'filed'/'regressed', still present → `existing`
 *     (already known / flagged) + `touch`. NEVER re-emitted.
 *   - in ledger, 'done' → REGRESSION only if occurrences post-date resolvedAt
 *     (`lastSeen > resolvedAt`): `kind:"regression"` candidate + `regress`. If all
 *     occurrences predate resolvedAt (stale rows) → just `touch`.
 * Noise filtering happens UPSTREAM in the endpoint (isNoise) before grouping.
 *
 * Batch cap: new + regression candidates share ONE cap. Deterministic order —
 * regressions first (worse than new), then count desc, lastSeen desc, signature
 * asc. Overflow → `deferred` (still upserted, so it emits next run).
 */
export function reconcileFaults(
  grouped: GroupedFault[],
  existing: FaultLedgerRow[],
  now: Date,
  opts: { minCount?: number; minSessions?: number; batchCap?: number } = {}
): ReconcileFaultsResult {
  const minCount = opts.minCount ?? DEFAULT_MIN_COUNT;
  const minSessions = opts.minSessions ?? DEFAULT_MIN_SESSIONS;
  const batchCap = opts.batchCap ?? DEFAULT_BATCH_CAP;
  const nowMs = now instanceof Date && Number.isFinite(now.getTime()) ? now.getTime() : Date.now();

  const bySignature = new Map<string, FaultLedgerRow>();
  for (const row of Array.isArray(existing) ? existing : []) {
    if (row && typeof row.signature === "string" && row.signature) {
      bySignature.set(row.signature, row);
    }
  }

  const existingActive: FaultLedgerRow[] = [];
  const upserts: LedgerUpsert[] = [];
  const candidates: FaultCandidate[] = [];

  for (const g of Array.isArray(grouped) ? grouped : []) {
    // Guard unparseable input — a bad group must not abort the scan.
    if (!g || typeof g.signature !== "string" || !g.signature) continue;

    const groupCount = safeNum(g.count, 0);
    const groupSessions = safeNum(g.distinctSessions, 0);
    const groupFirst = safeNum(g.firstSeen, nowMs);
    const groupLast = safeNum(g.lastSeen, nowMs);
    const route = typeof g.route === "string" ? g.route : null;
    const errorClass = typeof g.errorClass === "string" ? g.errorClass : "";

    const eligible = groupCount >= minCount || groupSessions >= minSessions;
    const row = bySignature.get(g.signature);

    if (!row) {
      // Never seen before. Emit only if it cleared the threshold — a true
      // one-off (sub-threshold, no ledger row) is ignored entirely.
      if (!eligible) continue;
      candidates.push({
        signature: g.signature,
        route,
        errorClass,
        count: groupCount,
        firstSeen: groupFirst,
        lastSeen: groupLast,
        token: tokenFor(g.signature),
        kind: "new",
      });
      upserts.push({
        op: "propose",
        signature: g.signature,
        route,
        errorClass,
        firstSeen: groupFirst,
        lastSeen: groupLast,
        count: groupCount,
        createdAt: nowMs,
      });
      continue;
    }

    // Already in the ledger. Compute the bumped snapshot once.
    const bumpedLast = Math.max(row.lastSeen, groupLast);
    const bumpedCount = safeNum(row.count, 0) + groupCount;

    if (row.status === "done") {
      const resolvedAt = row.resolvedAt;
      const recurred = resolvedAt != null && groupLast > resolvedAt;
      if (recurred) {
        // Recurred after being marked done → a regression.
        candidates.push({
          signature: g.signature,
          route,
          errorClass,
          count: bumpedCount,
          firstSeen: safeNum(row.firstSeen, groupFirst),
          lastSeen: bumpedLast,
          token: tokenFor(g.signature),
          kind: "regression",
        });
        upserts.push({
          op: "regress",
          signature: g.signature,
          lastSeen: bumpedLast,
          count: bumpedCount,
        });
      } else {
        // Stale occurrences that all predate the resolution — not a regression.
        upserts.push({
          op: "touch",
          signature: g.signature,
          lastSeen: bumpedLast,
          count: bumpedCount,
        });
      }
      continue;
    }

    // 'proposed' | 'filed' | 'regressed' → already known / flagged. Don't re-emit.
    existingActive.push(row);
    upserts.push({
      op: "touch",
      signature: g.signature,
      lastSeen: bumpedLast,
      count: bumpedCount,
    });
  }

  // Deterministic batch-cap ordering: regressions first (worse than new), then
  // count desc, lastSeen desc, signature asc.
  candidates.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "regression" ? -1 : 1;
    if (a.count !== b.count) return b.count - a.count;
    if (a.lastSeen !== b.lastSeen) return b.lastSeen - a.lastSeen;
    return a.signature.localeCompare(b.signature);
  });

  const toEmit: FaultCandidate[] = [];
  const regressions: FaultCandidate[] = [];
  const deferred: FaultCandidate[] = [];
  candidates.forEach((c, i) => {
    if (i < batchCap) {
      if (c.kind === "regression") regressions.push(c);
      else toEmit.push(c);
    } else {
      deferred.push(c);
    }
  });

  return { toEmit, existing: existingActive, regressions, deferred, upserts };
}
