/**
 * OPE-76 — CPI Move 2: the pure reconcile core for auto-filing dashboard signals
 * as OPE issues.
 *
 * ── Why a RAIL and not a cron that files directly ─────────────────────────────
 * Per the CPI design §35 the acting layer is "OPE/Linear + scheduled agent runs".
 * A Cloudflare Worker CANNOT call the Linear MCP `save_issue` (an agent-session
 * tool) and there is NO Linear API token in this codebase. So the developer
 * builds the RAIL that makes safe auto-filing possible — this dedup + rate-cap +
 * resolution ledger — and a scheduled agent run does the actual filing.
 *
 * ── Agent handoff (companion work, NOT this PR) ───────────────────────────────
 * A scheduled agent run (developer-claude-code / analyst-claude-desktop):
 *   1. POSTs /api/internal/cpi/fileable-signals (X-Internal-Key). The endpoint
 *      runs this reconcile core and returns { toFile, existing, resolved, deferred }.
 *   2. For each `toFile` signal: files ONE OPE via Linear `save_issue`, embedding
 *      `cpi-sig:<fingerprint>` in the OPE body (its own Linear dup pre-flight) and
 *      the standard `[agent instructions][<agentCode>][task]` routing bracket —
 *      `agentCode` on each signal says which agent owns it.
 *   3. POSTs /api/internal/cpi/record-filing { fingerprint, opeId } so the next
 *      scan sees the row as 'filed' (not re-proposed).
 *   4. Comments on `existing` (already-known, don't re-file) and closes/comments
 *      the `resolved` ones (the signal returned to green).
 * `deferred` signals are rate-capped overflow: already persisted as 'proposed',
 * so they file on the next run — a flapping signal can't spam Linear.
 *
 * This module is PURE (no db, no I/O) and never throws.
 *
 * NOTE (flagged for review): the ticket assumed OPE-78's `slaStatus`/`hoursInRed`
 * fields on ActionQueueEntry, but OPE-78 is not present on this branch — the type
 * only carries `firstDetectedAt`. So `isFileable` derives the P1 "aged past the
 * Move-1 threshold" test from `firstDetectedAt` + STALE_THRESHOLD_HOURS.P1 (72h),
 * the exact same age gate Move-1 uses. When OPE-78 lands, this can read slaStatus
 * directly without changing the fileability semantics.
 */

import type { ActionQueueEntry } from "@/lib/analytics-overview/types";
import { STALE_THRESHOLD_HOURS } from "@/lib/cpi/stale-reds";

const MS_PER_HOUR = 3_600_000;

/** Default number of NEW signals filed per run — the rate cap (flap guard). */
export const DEFAULT_RATE_CAP_PER_RUN = 5;

/**
 * Routing bracket the agent embeds in the OPE `[agent instructions][<code>][task]`:
 *   - developer-claude-code  → kpi / data / infra signals (the code owns the fix)
 *   - analyst-claude-desktop → recommendation (content/judgment) signals
 */
export type AgentCode = "developer-claude-code" | "analyst-claude-desktop";

export type FilingStatus = "proposed" | "filed" | "resolved";

/** A signal ready for the agent to act on. Times: firstDetectedAt is ISO. */
export interface FileableSignal {
  fingerprint: string;
  priority: "P0" | "P1";
  title: string;
  href: string;
  firstDetectedAt: string | null;
  /** Hours since firstDetectedAt (loosely "hours in red"); null if no stamp. */
  hoursInRed: number | null;
  agentCode: AgentCode;
  /** Present on `existing` signals whose row was already filed. */
  opeId?: string | null;
}

/** A ledger row, times as ms-epoch numbers (the endpoint maps Date ↔ number). */
export interface LedgerRow {
  fingerprint: string;
  priority: string;
  title: string;
  href: string;
  firstDetectedAt: number | null;
  lastSeenAt: number;
  status: FilingStatus;
  opeId: string | null;
  filedAt: number | null;
  resolvedAt: number | null;
  createdAt: number;
}

/**
 * A ledger mutation the endpoint applies. Times are ms-epoch numbers.
 *   - propose: insert a NEW 'proposed' row, or REOPEN a returned 'resolved' one
 *     (endpoint uses onConflictDoUpdate, preserving the original createdAt and
 *     clearing opeId/filedAt/resolvedAt).
 *   - touch:   bump last_seen + refresh snapshot on a still-active proposed/filed row.
 *   - resolve: mark a proposed/filed row 'resolved' (signal returned to green).
 */
export type LedgerUpsert =
  | {
      op: "propose";
      fingerprint: string;
      priority: string;
      title: string;
      href: string;
      firstDetectedAt: number | null;
      lastSeenAt: number;
      createdAt: number;
    }
  | {
      op: "touch";
      fingerprint: string;
      priority: string;
      title: string;
      href: string;
      firstDetectedAt: number | null;
      lastSeenAt: number;
    }
  | { op: "resolve"; fingerprint: string; resolvedAt: number; lastSeenAt: number };

export interface ReconcileResult {
  /** NEW incidents to file this run (within the rate cap). */
  toFile: FileableSignal[];
  /** Already proposed/filed and still fileable — the agent comments, not re-files. */
  existing: FileableSignal[];
  /** Rows that dropped out of the fileable set — the agent closes/comments these. */
  resolved: LedgerRow[];
  /** NEW incidents over the rate cap — persisted 'proposed', file next run. */
  deferred: FileableSignal[];
  /** The ledger mutations the endpoint should apply. */
  upserts: LedgerUpsert[];
}

/** Stable per-signal fingerprint — the ledger PK. Constant across scans. */
export function fingerprintFor(entry: Pick<ActionQueueEntry, "source" | "refKey">): string {
  return `cpi:${entry.source}:${entry.refKey}`;
}

/** Hours since firstDetectedAt, or null when the stamp is absent/unparseable. */
function hoursInStateFor(
  entry: Pick<ActionQueueEntry, "firstDetectedAt">,
  now: Date
): number | null {
  if (!entry.firstDetectedAt) return null;
  const ms = new Date(entry.firstDetectedAt).getTime();
  if (Number.isNaN(ms)) return null;
  return (now.getTime() - ms) / MS_PER_HOUR;
}

/** ms-epoch of firstDetectedAt, or null when absent/unparseable. */
function firstDetectedMs(entry: Pick<ActionQueueEntry, "firstDetectedAt">): number | null {
  if (!entry.firstDetectedAt) return null;
  const ms = new Date(entry.firstDetectedAt).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Fileability: a P0 is always fileable; a P1 only once it has aged past the
 * Move-1 threshold (72h) — i.e. a degradation that stuck around. See the module
 * NOTE for why this is derived from firstDetectedAt rather than a slaStatus flag.
 */
export function isFileable(entry: ActionQueueEntry, now: Date = new Date()): boolean {
  if (entry.priority === "P0") return true;
  const hrs = hoursInStateFor(entry, now);
  return hrs !== null && hrs > STALE_THRESHOLD_HOURS.P1;
}

/** Which agent owns the fix — kpi/data/infra → developer; recommendation → analyst. */
export function routeAgentCode(entry: Pick<ActionQueueEntry, "source">): AgentCode {
  return entry.source === "recommendation" ? "analyst-claude-desktop" : "developer-claude-code";
}

/**
 * Reconcile the current fileable signals against the ledger. PURE, never throws.
 *
 * For each fileable signal (keyed by fingerprint):
 *   - no row, OR the row is 'resolved' → a NEW incident → candidate for `toFile`
 *     (rate-capped; overflow → `deferred`). Both are upserted as 'proposed'.
 *   - row is 'proposed'/'filed' → already known → `existing` (agent comments),
 *     last_seen bumped.
 * Ledger rows that are 'proposed'/'filed' but NOT in the current fileable set →
 * `resolved` (returned to green) → marked resolved for the agent to close.
 */
export function reconcileFilings(
  fileable: ActionQueueEntry[],
  existing: LedgerRow[],
  now: Date,
  opts: { rateCapPerRun?: number } = {}
): ReconcileResult {
  const rateCap = opts.rateCapPerRun ?? DEFAULT_RATE_CAP_PER_RUN;
  const nowMs = now.getTime();

  const byFingerprint = new Map<string, LedgerRow>();
  for (const row of existing) byFingerprint.set(row.fingerprint, row);

  const currentFingerprints = new Set<string>();
  const existingActive: FileableSignal[] = [];
  const upserts: LedgerUpsert[] = [];
  const candidates: Array<{ signal: FileableSignal; firstMs: number | null }> = [];

  for (const entry of fileable) {
    const fingerprint = fingerprintFor(entry);
    currentFingerprints.add(fingerprint);
    const firstMs = firstDetectedMs(entry);
    const signal: FileableSignal = {
      fingerprint,
      priority: entry.priority,
      title: entry.title,
      href: entry.href,
      firstDetectedAt: entry.firstDetectedAt,
      hoursInRed: hoursInStateFor(entry, now),
      agentCode: routeAgentCode(entry),
    };

    const row = byFingerprint.get(fingerprint);
    if (!row || row.status === "resolved") {
      // NEW incident: never seen, or previously resolved and now returned.
      candidates.push({ signal, firstMs });
    } else {
      // Already proposed/filed → known. Agent comments; carry the OPE id through.
      existingActive.push({ ...signal, opeId: row.opeId });
      upserts.push({
        op: "touch",
        fingerprint,
        priority: entry.priority,
        title: entry.title,
        href: entry.href,
        firstDetectedAt: firstMs,
        lastSeenAt: nowMs,
      });
    }
  }

  // Deterministic rate-cap order: P0 before P1, then longest-aged first, then
  // fingerprint — so the most urgent NEW incidents file first, overflow defers.
  candidates.sort((a, b) => {
    if (a.signal.priority !== b.signal.priority) return a.signal.priority === "P0" ? -1 : 1;
    const ah = a.signal.hoursInRed ?? -Infinity;
    const bh = b.signal.hoursInRed ?? -Infinity;
    if (ah !== bh) return bh - ah;
    return a.signal.fingerprint.localeCompare(b.signal.fingerprint);
  });

  const toFile: FileableSignal[] = [];
  const deferred: FileableSignal[] = [];
  candidates.forEach((c, i) => {
    // Every NEW candidate is persisted 'proposed' (so deferred ones file next run).
    upserts.push({
      op: "propose",
      fingerprint: c.signal.fingerprint,
      priority: c.signal.priority,
      title: c.signal.title,
      href: c.signal.href,
      firstDetectedAt: c.firstMs,
      lastSeenAt: nowMs,
      createdAt: nowMs,
    });
    if (i < rateCap) toFile.push(c.signal);
    else deferred.push(c.signal);
  });

  // Resolution: proposed/filed rows no longer in the fileable set returned to green.
  const resolved: LedgerRow[] = [];
  for (const row of existing) {
    if (
      (row.status === "proposed" || row.status === "filed") &&
      !currentFingerprints.has(row.fingerprint)
    ) {
      resolved.push(row);
      upserts.push({
        op: "resolve",
        fingerprint: row.fingerprint,
        resolvedAt: nowMs,
        lastSeenAt: nowMs,
      });
    }
  }

  return { toFile, existing: existingActive, resolved, deferred, upserts };
}
