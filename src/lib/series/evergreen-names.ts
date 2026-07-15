/**
 * OPE-197 — pure planner for the one-time "evergreen the legacy series names"
 * cleanup.
 *
 * A series spans editions, so its display name must not carry one occurrence's
 * year: the landing hub renders `${series.name} — Meet Me at the Fair`
 * (event-detail-data.ts), and a year-stamped hub title is a near-duplicate of
 * its own /YYYY occurrence — which is what lets both URLs rank for the same
 * dated query (GSC, 2026-07-14: Whaling City Festival, Cambridge Arts River).
 *
 * The BUILDER is already correct — the only `insert(eventSeries)`
 * (api/admin/series/backfill/route.ts:280) already applies
 * `stripNameEditionSuffix`, and no `update(eventSeries)` name-writer exists. So
 * the ~1,146 year-stamped rows are legacy, created before that guard shipped:
 * the classic stored-vs-current-generator divergence. This module plans their
 * one-time correction; it is pure (no DB, no I/O) so the diff can be reviewed
 * and unit-tested before anything customer-facing is written.
 *
 * The transformation ALWAYS defers to `stripNameEditionSuffix` — deliberately
 * the same function the builder uses, so a cleaned row is byte-identical to
 * what a fresh insert would mint today, and the cleanup cannot drift from the
 * builder. Do NOT reimplement or broaden it here (John, OPE-197): the ~300
 * rows whose 4-digit number is not a trailing edition token ("Route 66 Rally",
 * street addresses) must keep their names, and that function already no-ops on
 * them.
 */
import { stripNameEditionSuffix } from "./group-events";

/** Minimal `event_series` projection this module needs. */
export interface SeriesNameRow {
  id: string;
  canonicalSlug: string;
  name: string;
}

/** One proposed rename. `to` is always `stripNameEditionSuffix(from)`. */
export interface EvergreenRename {
  id: string;
  canonicalSlug: string;
  from: string;
  to: string;
  /** The trailing edition token being dropped, e.g. "2026" or "2026-09-19". */
  token: string;
  /** "19xx" | "20xx" — review bucket only; never gates the transformation. */
  century: "19xx" | "20xx";
}

export interface EvergreenPlan {
  totalSeries: number;
  /** Every row whose name would change (minus `excludeIds`). */
  renames: EvergreenRename[];
  /**
   * The `19xx` subset — the ONLY interpretive edge, split out for human review.
   * `stripNameEditionSuffix` anchors to end-of-string, so a legitimately-named
   * "…Established since 1950" would lose its 1950 exactly as a trailing edition
   * year would. That is consistent with the builder (a new such series gets the
   * same treatment), but a real "since 19xx" name is a false positive worth
   * eyeballing before a bulk write. Every `20xx` strip is unambiguous.
   */
  nineteenXx: EvergreenRename[];
  /** Rows that WOULD have been renamed but were explicitly carved out. */
  excluded: EvergreenRename[];
}

/**
 * Classification ONLY: which trailing token `stripNameEditionSuffix` will drop.
 * Mirrors that function's token shape purely to bucket the diff for review
 * (19xx vs 20xx) and to report what was removed. It never drives a write — the
 * rename value always comes from `stripNameEditionSuffix`. If the two ever
 * disagree, the row is skipped as unclassifiable rather than guessed at.
 */
const EDITION_TOKEN_RE = /((?:19|20)\d\d(?:-\d\d){0,2})\s*$/;

/**
 * Plan the evergreen rename set.
 *
 * Idempotent by construction: a row is only proposed when
 * `stripNameEditionSuffix(name) !== name`, so re-running after a successful
 * pass yields an empty plan (that emptiness IS the acceptance check).
 *
 * @param rows every `event_series` row (id + canonical_slug + name)
 * @param opts.excludeIds series ids to carve out (a confirmed 19xx false
 *   positive) — reported under `excluded` rather than silently dropped.
 */
export function planEvergreenNames(
  rows: SeriesNameRow[],
  opts: { excludeIds?: string[] } = {}
): EvergreenPlan {
  const excludeIds = new Set(opts.excludeIds ?? []);
  const renames: EvergreenRename[] = [];
  const excluded: EvergreenRename[] = [];

  for (const row of rows) {
    const to = stripNameEditionSuffix(row.name);
    // No trailing edition token (or stripping would empty the name — the
    // function's own `stripped || name` guard, e.g. a series literally named
    // "2026"). Already evergreen; leave it alone.
    if (to === row.name) continue;

    const token = row.name.match(EDITION_TOKEN_RE)?.[1];
    // Defensive: the strip changed the name but the classifier can't name the
    // token, so the two disagree about this row's shape. Skip rather than write
    // a rename we can't explain in the audit trail.
    if (!token) continue;

    const rename: EvergreenRename = {
      id: row.id,
      canonicalSlug: row.canonicalSlug,
      from: row.name,
      to,
      token,
      century: token.startsWith("19") ? "19xx" : "20xx",
    };
    (excludeIds.has(row.id) ? excluded : renames).push(rename);
  }

  return {
    totalSeries: rows.length,
    renames,
    nineteenXx: renames.filter((r) => r.century === "19xx"),
    excluded,
  };
}
