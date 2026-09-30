/**
 * OPE-811 — the canonical `fault_signatures.status` vocabulary, in one place.
 *
 * It has to be one place because there were three, and they were disjoint.
 * Measured against production D1 on 2026-09-05 (68 rows):
 *
 *   status      rows   unfiled   written by
 *   ─────────────────────────────────────────────────────────────────
 *   noise         35        34   an agent, direct to D1
 *   proposed      19        19   CODE (`/api/internal/faults/candidates`)
 *   open           8         0   an agent, direct to D1
 *   resolved       3         0   an agent, direct to D1
 *   watch          2         2   an agent, direct to D1
 *   done           1         0   CODE (`/api/internal/faults/record-candidate`)
 *
 * `filed` and `regressed` are declared by the code's state machine and have
 * **zero rows in production**. `open`, `noise`, `watch` and `resolved` are
 * written by agents and are **absent from the code's type**. So the two halves
 * of this pipeline share exactly two words — `proposed` and `done` — and 45 of
 * 68 rows carry a status the code has never heard of.
 *
 * That divergence is not cosmetic. `candidates/route.ts` casts the column with
 * `r.status as FaultStatus`, an unchecked assertion, and `reconcileFaults` then
 * routes anything that is not `done` into the ignore bucket. An agent writing
 * `watch` believes it has parked a row for later; the code reads it as "already
 * handled, no work here". Nobody is wrong and the row never moves again.
 *
 * ## The rule
 *
 * A status answers exactly one question: **does this signature still need a
 * human decision?** Anything else — priority, family, who owns it — belongs in
 * another column. Statuses are grouped here by that answer, and every predicate
 * below is derived from the groups rather than from a hand-written list, so a
 * new status cannot be added to one predicate and forgotten in the others.
 */

/** Statuses the application's own state machine writes. */
export const CODE_STATUSES = ["proposed", "filed", "regressed", "done"] as const;

/**
 * Statuses only ever written by an agent working the CPI rail by hand.
 *
 * Kept as first-class values rather than normalised away. They record real
 * adjudications — 35 rows judged `noise` is 35 decisions someone made — and
 * rewriting them to fit the code's vocabulary would destroy that history to
 * make a type tidier.
 */
export const AGENT_STATUSES = ["open", "noise", "watch", "resolved"] as const;

export type FaultStatusValue = (typeof CODE_STATUSES)[number] | (typeof AGENT_STATUSES)[number];

export const ALL_FAULT_STATUSES: readonly FaultStatusValue[] = [
  ...CODE_STATUSES,
  ...AGENT_STATUSES,
];

/**
 * Statuses meaning "this signature is a live candidate that still needs filing".
 *
 * `open` is here because that is what the rail's Procedure A has always queried
 * for, and eight production rows use it. `proposed` is here because that is what
 * the emitter actually writes. **The whole defect was that no single reader
 * looked at both.**
 */
const FILEABLE = new Set<FaultStatusValue>(["proposed", "regressed", "open"]);

/**
 * Statuses meaning "a decision was made; do not surface this again".
 *
 * `noise` and `resolved` and `done` are decisions. `watch` is deliberately NOT
 * fileable and NOT terminal — see `isParked`.
 */
const TERMINAL = new Set<FaultStatusValue>(["done", "resolved", "noise"]);

/** A signature that still needs to be filed as an OPE. */
export function isFileableStatus(status: string | null | undefined): boolean {
  return FILEABLE.has(status as FaultStatusValue);
}

/** A signature whose disposition is settled. Never resurface. */
export function isTerminalStatus(status: string | null | undefined): boolean {
  return TERMINAL.has(status as FaultStatusValue);
}

/**
 * `watch` — seen, judged real, deliberately not filed yet.
 *
 * Its own category on purpose. A parked row is unfiled by DESIGN, so counting it
 * as a missed candidate would make the OPE-811 health assertion below fire
 * permanently and get itself muted within a fortnight — which is how the
 * original defect survived: an alarm that is always on is an alarm nobody reads.
 */
export function isParked(status: string | null | undefined): boolean {
  return status === "watch";
}

/**
 * A status the code does not recognise at all.
 *
 * Returns true for a value outside both vocabularies. Callers should treat an
 * unknown status as **fileable-unknown**, never as handled: the failure that
 * produced this module was an unrecognised value being silently read as
 * "already dealt with".
 */
export function isUnknownStatus(status: string | null | undefined): boolean {
  return !ALL_FAULT_STATUSES.includes(status as FaultStatusValue);
}

/**
 * The health assertion behind OPE-811 scope 2: is the rail actually working?
 *
 * A run that files nothing is only healthy if there was nothing to file. This
 * separates those two cases, which is precisely what the pipeline could not do
 * — the weekly routine reported `SUCCEEDED` on 2026-09-01 with 19 unrouted
 * candidates in the ledger, because it asserted on its own query returning zero
 * rather than on the population.
 *
 * ⚠️ Scoped to `isFileableStatus`, NOT to the ticket's suggested
 * `status NOT IN ('noise','done')`. That predicate would have counted the two
 * `watch` rows — unfiled by design — and the assertion would have been in a
 * failing state from the moment it shipped.
 */
export function unfiledCandidateCount(
  rows: ReadonlyArray<{ status: string | null; opeId: string | null }>
): number {
  return rows.filter(
    (r) => r.opeId == null && (isFileableStatus(r.status) || isUnknownStatus(r.status))
  ).length;
}

/** The rail's self-assessment for one run (OPE-811 scope 2). */
export interface RailHealth {
  /** Fileable, unfiled rows in the whole ledger — the population. */
  unfiledCandidates: number;
  /** Rows this run actually hands the agent to file. */
  emittingNow: number;
  /** Parked (`watch`) rows — unfiled by design, reported so the 0 is legible. */
  parked: number;
  /** Rows carrying a status the code does not know. */
  unknownStatus: number;
  /**
   * FALSE when the run files nothing while fileable work exists.
   *
   * This is the whole ticket in one boolean. The rail was not lying when it
   * reported success — it asked "did my query return rows?", got no, and
   * answered honestly. The question was wrong.
   */
  healthy: boolean;
  /** Why it is unhealthy, for the run log. Empty when healthy. */
  reason: string;
}

export function buildRailHealth(
  ledger: ReadonlyArray<{ status: string | null; opeId: string | null }>,
  emitted: { toEmit: unknown[]; backlog: unknown[]; regressions: unknown[] }
): RailHealth {
  const unfiledCandidates = unfiledCandidateCount(ledger);
  const emittingNow = emitted.toEmit.length + emitted.backlog.length + emitted.regressions.length;
  const parked = ledger.filter((r) => isParked(r.status)).length;
  const unknownStatus = ledger.filter((r) => isUnknownStatus(r.status)).length;

  const starved = unfiledCandidates > 0 && emittingNow === 0;
  return {
    unfiledCandidates,
    emittingNow,
    parked,
    unknownStatus,
    healthy: !starved,
    reason: starved
      ? `${unfiledCandidates} fileable signature(s) carry no ope_id and this run emitted none — ` +
        `the rail is reading a population it cannot file from (OPE-811).`
      : "",
  };
}
