/**
 * OPE-740 scope 5 — for each projected date, what could ever confirm it?
 *
 * ## What was actually measured (prod, 2026-09-06)
 *
 * 124 rows carry a rollover ingestion method — 121 `annual_rollover`,
 * 3 `manual_rollover`, and **zero `auto_rollover`**, because the committed
 * writer has never run. All 124 were created 2026-06-13→15 by an offline
 * script, all are TENTATIVE, and all start in 2027 (2027-02-03 → 2027-10-09).
 *
 * Splitting them by what backs the date:
 *
 * | bucket        |  n  | what it means                                       |
 * |---------------|-----|-----------------------------------------------------|
 * | `attested`    |   2 | a date citation or `event_days` exists              |
 * | `checkable`   |  99 | no attestation, but a `source_url` to go and read    |
 * | `silent`      |  23 | no attestation and no URL — nothing can confirm it   |
 *
 * ## Why `silent` is the bucket that escalates
 *
 * The hedge copy this ticket adds is honest about all 122 unattested rows, and
 * for the 99 the hedge is temporary: OPE-814 widened the drift sweep to include
 * TENTATIVE events on promoter-owned domains **regardless of the forward
 * window**, which is what these needed — starting in 2027, every one of them
 * sat outside the old 30/90-day slice and the sweep could not see them. 36 are
 * on the promoter's own domain and are now reachable.
 *
 * The 23 are different in kind, not degree. There is no citation, no
 * `event_days` row, and no URL: no sweep that could be written would resolve
 * them, because there is nowhere to look. They are permanently unfalsifiable
 * date claims on publicly indexed pages, and they do not age out — they age in,
 * as 2027 approaches and readers start planning against them.
 *
 * ⚠️ So the red is NOT "we publish projected dates". That is fine, and now
 * labelled. The red is "we publish projected dates that nothing on file can
 * ever check", which is a different sentence and a much smaller number.
 *
 * ## Why this is a classification and not a fix
 *
 * Two of the 124 carry `dates_confirmed = 1` on a projected date, and one is
 * the Hartford County 4-H Fair. Both are STOP-gated pending John — correcting
 * them changes what a public page asserts, and `dates_confirmed` is the flag an
 * operator uses to mean "I checked this myself". Guessing which of the two it
 * was would destroy the only signal distinguishing them.
 *
 * This module therefore measures and escalates. It writes nothing.
 */
import { and, eq, exists, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { events, eventDataCitations, eventDays } from "@/lib/db/schema";
import { ROLLOVER_INGESTION_METHODS } from "@/lib/events/derived-date";
import type { StaleRed } from "@/lib/cpi/stale-reds";
import type { Db } from "@/lib/analytics-overview/shared";

const MS_PER_HOUR = 3_600_000;

/** Where an operator goes to act on these. */
const REVIEW_HREF = "/admin/events?flagged=1";

/** Citation fields that count as backing a date claim. Mirrors OPE-384. */
const DATE_CITATION_FIELDS = ["start_date", "end_date"];

/**
 * What, if anything, could confirm this projected date.
 *
 * Ordered by how much recourse exists, most to least.
 */
export type AttestationBucket =
  /** A date citation or `event_days` row exists — somebody asserted this. */
  | "attested"
  /** No attestation, but a `source_url` the drift sweep can go and read. */
  | "checkable"
  /** No attestation and no URL. Nothing on file can ever confirm it. */
  | "silent";

export interface AttestationInput {
  hasDateCitation: boolean;
  hasEventDays: boolean;
  sourceUrl: string | null | undefined;
}

/**
 * Classify one projected row.
 *
 * ⚠️ `attested` wins over everything, including over having no URL. A row with
 * a citation is backed whether or not we also kept a link — conflating "no URL"
 * with "unbacked" would put the 2 `dates_confirmed = 1` rows in `silent` and
 * make the escalating bucket 25, which is the wrong number for the wrong
 * reason: those two are backed AND wrong, a different defect that is STOP-gated.
 */
export function classifyAttestation(input: AttestationInput): AttestationBucket {
  if (input.hasDateCitation || input.hasEventDays) return "attested";
  const url = (input.sourceUrl ?? "").trim();
  return url === "" ? "silent" : "checkable";
}

export interface ProjectedDateRow {
  id: string;
  slug: string;
  name: string;
  bucket: AttestationBucket;
  sourceUrl: string | null;
  /** Creation time, as mapped by Drizzle's `timestamp` mode. */
  createdAt: Date | null;
}

export interface ProjectedDateAttestation {
  attested: number;
  checkable: number;
  silent: number;
  total: number;
  /**
   * Every projected row with its bucket — the per-row artifact scope 5 asks
   * for. Counts alone cannot answer "which ones", which is the question an
   * operator or a follow-up sweep actually has.
   */
  rows: ProjectedDateRow[];
  /**
   * Whether `rows` is the complete set. False when the cap was hit, in which
   * case the counts describe the capped sample rather than the population.
   *
   * ⚠️ Separate from `total` deliberately: "0 silent" and "we stopped looking"
   * must not share a representation. That collapse is the defect family this
   * session has now shipped four fixes for (OPE-804, 803, 811, 808).
   */
  complete: boolean;
  /**
   * Creation time of the OLDEST `silent` row. Null when there are none.
   *
   * The red ages against this rather than against the scan, so a backlog that
   * has been unfalsifiable since June escalates on the first scan instead of
   * starting a fresh countdown each night.
   */
  oldestSilentAt: Date | null;
}

/**
 * Hard cap on rows examined. 124 exist today and the cohort only grows when a
 * rollover runs, so this is far above the population — it exists so a runaway
 * rollover cannot turn a nightly scan into a full-table read.
 */
export const PROJECTED_ROW_CAP = 2000;

/**
 * Classify every projected row.
 *
 * ⚠️ The bucketing lives in `classifyAttestation`, in TypeScript, NOT in the
 * SQL. An earlier version aggregated the buckets with `SUM(CASE WHEN …)` and
 * kept `classifyAttestation` beside it for the tests — two implementations of
 * one rule, the second with no caller, free to drift. OPE-726's inert-detector
 * guard caught exactly that. The SQL now reports raw facts and the rule has one
 * home.
 *
 * ⚠️ Excludes tombstones (`merged_into IS NOT NULL`). A merged row's slug 301s
 * to its keeper, so it renders nothing and cannot mislead anyone — counting it
 * would inflate the red with pages that do not exist.
 */
export async function loadProjectedDateAttestation(db: Db): Promise<ProjectedDateAttestation> {
  const raw = await db
    .select({
      id: events.id,
      slug: events.slug,
      name: events.name,
      sourceUrl: events.sourceUrl,
      createdAt: events.createdAt,
      // ⚠️ `exists()`, NOT a raw sql`EXISTS (…)` template.
      //
      // Drizzle renders `${table.column}` inside a raw template as a BARE
      // column name, so `WHERE ${eventDataCitations.eventId} = ${events.id}`
      // becomes `WHERE "event_id" = "id"` — and inside the subquery `"id"`
      // binds to event_data_citations' OWN id. The correlation silently
      // self-joins, the subquery is never true, and every row classifies as
      // `silent`: 124 instead of 23, wrong in the alarming direction. Caught
      // by the fixture; a prod spot-check of one silent row would not have.
      // The query builder qualifies both sides.
      hasDateCitation: exists(
        db
          .select({ one: sql`1` })
          .from(eventDataCitations)
          .where(
            and(
              eq(eventDataCitations.eventId, events.id),
              eq(eventDataCitations.state, "active"),
              inArray(eventDataCitations.fieldName, DATE_CITATION_FIELDS)
            )
          )
      ),
      hasEventDays: exists(
        db
          .select({ one: sql`1` })
          .from(eventDays)
          .where(eq(eventDays.eventId, events.id))
      ),
    })
    .from(events)
    .where(
      and(
        isNull(events.mergedInto),
        ne(events.status, "REJECTED"),
        or(
          inArray(events.ingestionMethod, [...ROLLOVER_INGESTION_METHODS]),
          isNotNull(events.rolledFromEventId)
        )
      )
    )
    .limit(PROJECTED_ROW_CAP + 1);

  const complete = raw.length <= PROJECTED_ROW_CAP;
  const capped = complete ? raw : raw.slice(0, PROJECTED_ROW_CAP);

  const rows: ProjectedDateRow[] = capped.map((r) => ({
    id: String(r.id),
    slug: String(r.slug ?? ""),
    name: String(r.name ?? ""),
    sourceUrl: r.sourceUrl ?? null,
    bucket: classifyAttestation({
      hasDateCitation: Boolean(r.hasDateCitation),
      hasEventDays: Boolean(r.hasEventDays),
      sourceUrl: r.sourceUrl,
    }),
    // ⚠️ No seconds→ms widening here, deliberately. `events.created_at` is
    // declared `integer(..., { mode: "timestamp" })`, so the query builder's
    // mapper already returns a Date. OPE-384's sibling module DOES widen,
    // because it reads the column through a raw `MIN()` aggregate, which
    // bypasses the mapper and hands back the stored number. Adding the same
    // `* 1000` here would push every date 55,000 years out; adding a defensive
    // branch for it would be a branch nothing can reach.
    createdAt: r.createdAt ?? null,
  }));

  const count = (b: AttestationBucket) => rows.filter((r) => r.bucket === b).length;
  const silentRows = rows.filter((r) => r.bucket === "silent");
  const oldest = silentRows.reduce<Date | null>((acc, r) => {
    if (!r.createdAt) return acc;
    return acc === null || r.createdAt < acc ? r.createdAt : acc;
  }, null);

  return {
    total: rows.length,
    silent: silentRows.length,
    checkable: count("checkable"),
    attested: count("attested"),
    rows,
    complete,
    oldestSilentAt: oldest,
  };
}

/**
 * The red, when there is one.
 *
 * No tunable floor and no invented threshold: a published date that nothing on
 * file can ever confirm is a defect at any count, and unlike the `checkable`
 * bucket there is no process that drains it. The floor is `> 0` for the same
 * reason OPE-384's is.
 */
export function assessProjectedDateAttestation(
  state: ProjectedDateAttestation,
  now: Date
): StaleRed | null {
  if (state.silent <= 0 || state.oldestSilentAt === null) return null;

  return {
    // ⚠️ P1 because `StaleRed` admits only P0/P1 — not because this is as
    // severe as OPE-384's uncited *confirmed* dates, which are APPROVED rows
    // asserting a verified date. These are TENTATIVE and now visibly hedged.
    // Recorded rather than silently rounded up: an operator triaging by
    // priority should know the scale has no rung below this one.
    priority: "P1",
    title:
      `Unfalsifiable projected dates (OPE-740): ${state.silent} public event ` +
      `page${state.silent === 1 ? "" : "s"} show a date we generated by ` +
      `shifting last year's, with no citation, no event_days and no source_url ` +
      `— nothing on file can ever confirm or refute them. ` +
      `(${state.checkable} more are projected but have a URL the drift sweep ` +
      `can read; ${state.attested} are attested.)` +
      // ⚠️ A capped scan reports a LOWER BOUND, and must say so. "23 silent"
      // and "at least 23, we stopped counting" are different claims, and this
      // session has now shipped four fixes for exactly that collapse.
      (state.complete
        ? ""
        : ` ⚠️ Scan capped at ${PROJECTED_ROW_CAP} rows — counts are a lower bound.`),
    // Constant refKey, no count: the CPI rail files ONE ticket for the
    // condition and the digest does not re-mail when the number moves by one.
    refKey: "event-dates:projected-unfalsifiable",
    href: REVIEW_HREF,
    firstDetectedAt: state.oldestSilentAt.toISOString(),
    hoursInRed: (now.getTime() - state.oldestSilentAt.getTime()) / MS_PER_HOUR,
  };
}

/** Load + assess. Returns [] when healthy, so it merges into `allReds` directly. */
export async function assessAllProjectedDateAttestation(db: Db, now: Date): Promise<StaleRed[]> {
  const red = assessProjectedDateAttestation(await loadProjectedDateAttestation(db), now);
  return red ? [red] : [];
}
