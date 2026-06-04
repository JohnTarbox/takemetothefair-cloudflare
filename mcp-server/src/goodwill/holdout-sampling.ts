/**
 * GW1.3 (2026-06-03) — Holdout-sampling cron.
 *
 * Daily random ~1% sample of events whose authoritative source is at
 * `confidence='established' AND score > 0.8`. For each sampled event,
 * re-fetch the source URL and re-run the K7 deterministic+AI extract
 * cascade, then compare fresh values against stored. Emit one
 * `event_discrepancies` row per field that diverged, with
 * `detected_by='holdout_sample'`.
 *
 * ## Why it exists
 *
 * The CPI guardrail in the GW1 spec: the index must NOT decide a high-
 * score source is never worth re-checking. Without holdout sampling, a
 * source page that gets compromised, redirected, or starts publishing
 * wrong dates after an admin change would silently keep its score
 * while quietly emitting bad ingests. This is the only mechanism in
 * GW1 that catches "the source we trust DRIFTED" before it shows up
 * as a downstream data-quality complaint.
 *
 * ## Scoring credit
 *
 * When a holdout discrepancy resolves, the source being re-checked IS
 * the authoritative side — GW1c's circularity guard handles this
 * correctly (the holdout-sampling source is the authoritative source
 * being tested, and the divergent value comes from the same source's
 * *current* page, so the "agreed-with-truth" credit goes to the right
 * side). See captureHoldoutSampleDiscrepancy for the credit shape.
 *
 * ## Cap and budget
 *
 * Cap at `MAX_PER_RUN=10` sequential events. Each event takes ~3-10s
 * wall-clock (fetch + extract HTTP round-trip to the main app), so
 * total ~30-100s — fits inside CF's cron invocation budget with
 * margin. The original spec called for 50/run; we're more
 * conservative on the first pass because the per-event cost is
 * variable and Browser Rendering escalation can push individual
 * fetches to ~25s. If coverage rates show 10/day is insufficient,
 * the follow-up is either parallelization (Promise.all chunks of 5)
 * or conversion to a CF Workflow with one `step.do` per event.
 *
 * The random sample over time covers the high-trust corpus: 10/day
 * × 365 = 3,650 re-checks/year, plenty for a few-hundred to low-
 * thousands corpus of `established + score>0.8` sources.
 *
 * ## Idempotence
 *
 * captureHoldoutSampleDiscrepancy's 24-hour guard on
 * (event_id, field_class, detected_by) means a re-run within the
 * day (e.g. cron retried by CF infrastructure) writes at most one
 * row per (event, field). Random sampling means the SAME event is
 * unlikely to be picked twice in the same day, but the guard makes
 * it safe even if RANDOM() happens to land on the same id twice.
 */

import { and, isNotNull, sql } from "drizzle-orm";
import { events, venues } from "../schema.js";
import type { Db } from "../db.js";
import { captureHoldoutSampleDiscrepancy, type FieldClass } from "./capture.js";
import { logError } from "../logger.js";
import { submitFetch, submitExtract } from "../email-handlers/submit.js";
import { NonRetryableError } from "cloudflare:workflows";

const MAX_PER_RUN = 10;
const HIGH_TRUST_SCORE_THRESHOLD = 0.8;

export interface HoldoutSamplingResult {
  /** How many events the SELECT returned (i.e. sampled). */
  sampled: number;
  /** How many fetches succeeded. */
  fetched: number;
  /** How many extracts succeeded (subset of fetched). */
  extracted: number;
  /** How many discrepancy rows were inserted (across all fields). */
  emitted: number;
  /** How many emit calls returned null due to the 24-hour idempotence
   *  guard (same event/field/detector already captured today). */
  skipped_dedup: number;
  /** How many events failed at fetch or extract. */
  errors: number;
}

export interface HoldoutEnv {
  DB: D1Database;
  MAIN_APP_URL: string;
  INTERNAL_API_KEY: string;
}

/**
 * Per [[feedback_drizzle_d1_unit_test_inject_db]] — accept `db: Db`
 * directly. The cron caller in `mcp-server/src/index.ts` wraps env.DB
 * via `getDb(env.DB)` and passes the env shape separately for the
 * cross-service fetch helpers.
 */
export async function runScheduledHoldoutSampling(
  db: Db,
  env: HoldoutEnv
): Promise<HoldoutSamplingResult> {
  const SOURCE = "mcp:schedule:holdout-sampling";
  const result: HoldoutSamplingResult = {
    sampled: 0,
    fetched: 0,
    extracted: 0,
    emitted: 0,
    skipped_dedup: 0,
    errors: 0,
  };

  try {
    // Sample the high-trust corpus.
    //
    // Gate: events whose `source_domain` is at `confidence='established'
    // AND score > 0.8` on the accuracy axis. Sources cross that bar by
    // having enough observations to stabilize the Beta posterior — that's
    // exactly the set we worry about "drifting silently".
    //
    // Why `events.source_domain` instead of going through
    // `event_data_citations.source_key` (the spec's literal text):
    // `event_data_citations` doesn't have a `source_key` column today —
    // it has `source_url`. And we want to re-fetch the EVENT'S source
    // page (`events.source_url`), so gating on the event's own source-
    // key is both schema-correct AND more semantically precise: we
    // only re-check when the page we're about to fetch is the one
    // whose reliability we trust. `events.source_domain` is already
    // lowercased + www-stripped (set by source-classification.ts at
    // write time per the schema comment), so it matches
    // `source_reliability.source_key` directly.
    //
    // The query is one statement; D1 does the random selection
    // server-side via ORDER BY RANDOM() LIMIT N. LEFT JOIN through
    // venues up front so the comparator has city/state without a
    // second round-trip per row.
    const sampled = await db
      .select({
        eventId: events.id,
        eventName: events.name,
        eventStartDate: events.startDate,
        eventEndDate: events.endDate,
        eventVenueId: events.venueId,
        eventSourceUrl: events.sourceUrl,
        venueCity: venues.city,
        venueState: venues.state,
      })
      .from(events)
      .leftJoin(venues, sql`${events.venueId} = ${venues.id}`)
      .where(
        and(
          isNotNull(events.sourceUrl),
          isNotNull(events.sourceDomain),
          sql`${events.sourceDomain} IN (
            SELECT source_key FROM source_reliability
            WHERE confidence = 'established'
              AND axis = 'accuracy'
              AND score > ${HIGH_TRUST_SCORE_THRESHOLD}
          )`
        )
      )
      .orderBy(sql`RANDOM()`)
      .limit(MAX_PER_RUN);

    result.sampled = sampled.length;

    for (const row of sampled) {
      if (!row.eventSourceUrl) continue; // shouldn't happen post-WHERE, defensive

      // Re-fetch — submitFetch throws on 4xx (NonRetryableError) or
      // 5xx/network (plain Error). Either way the event is unfetchable
      // right now; record + continue.
      let fetched: Awaited<ReturnType<typeof submitFetch>>;
      try {
        fetched = await submitFetch(
          { DB: env.DB, MAIN_APP_URL: env.MAIN_APP_URL, INTERNAL_API_KEY: env.INTERNAL_API_KEY },
          row.eventSourceUrl
        );
      } catch (err) {
        result.errors += 1;
        await logError(db, {
          level: "warn",
          source: SOURCE,
          message: `submitFetch failed for event=${row.eventId}`,
          error: err,
          context: { sourceUrl: row.eventSourceUrl },
        });
        continue;
      }
      result.fetched += 1;

      // Re-extract via the K7 deterministic+AI cascade. submitExtract
      // throws NonRetryableError on every failure mode by design (see
      // its header comment). Same per-event isolation as fetch.
      let extracted: Awaited<ReturnType<typeof submitExtract>>;
      try {
        extracted = await submitExtract(
          { DB: env.DB, MAIN_APP_URL: env.MAIN_APP_URL, INTERNAL_API_KEY: env.INTERNAL_API_KEY },
          fetched
        );
      } catch (err) {
        result.errors += 1;
        // NonRetryableError from extract is expected when the page now
        // has zero events (event ended + page was removed/repurposed)
        // or returns thin content. That's itself an interesting signal
        // — log at warn so the canary can pick it up if it spikes.
        const level: "warn" | "error" = err instanceof NonRetryableError ? "warn" : "error";
        await logError(db, {
          level,
          source: SOURCE,
          message: `submitExtract failed for event=${row.eventId}`,
          error: err,
          context: { sourceUrl: row.eventSourceUrl },
        });
        continue;
      }
      result.extracted += 1;

      // Compare each tracked field. We emit one discrepancy per
      // diverged field; multiple per event are possible (the source
      // page might have drifted on both date AND venue).
      const ev = extracted.event;
      const disagreements: Array<{
        fieldClass: FieldClass;
        stored: string | null;
        fresh: string | null;
        notes: string;
      }> = [];

      // ── date (start) ──────────────────────────────────────────
      const storedStart = row.eventStartDate ? toIsoDate(row.eventStartDate) : null;
      const freshStart = ev.startDate ? isoOrNull(ev.startDate) : null;
      if (storedStart && freshStart && storedStart !== freshStart) {
        disagreements.push({
          fieldClass: "date",
          stored: storedStart,
          fresh: freshStart,
          notes: `holdout: start_date drifted on source (${storedStart} → ${freshStart})`,
        });
      }

      // ── venue (city/state strings) ────────────────────────────
      // The K7 extract returns venue strings, not a resolved venueId.
      // Same proxy used by GW1.1's comparator — city/state mismatch is
      // a reliable signal of "the source page now names a different
      // location". Skip when the event has no venue at all (statewide
      // events, online-only).
      const storedVenue = composeVenue(row.venueCity, row.venueState);
      const freshVenue = composeVenue(ev.venueCity ?? null, ev.venueState ?? null);
      if (storedVenue && freshVenue && storedVenue.toLowerCase() !== freshVenue.toLowerCase()) {
        disagreements.push({
          fieldClass: "venue",
          stored: storedVenue,
          fresh: freshVenue,
          notes: `holdout: venue location drifted on source (${storedVenue} → ${freshVenue})`,
        });
      }

      // ── name ──────────────────────────────────────────────────
      // Conservative: exact normalized equality. We don't use a
      // Levenshtein threshold here because the two values come from
      // THE SAME source page — any change is intentional and worth
      // capturing. The threshold-based check used at ingest is for
      // CROSS-source comparison, where minor formatting differences
      // are common.
      const storedNameNorm = simpleNormalize(row.eventName);
      const freshNameNorm = simpleNormalize(ev.name);
      if (storedNameNorm && freshNameNorm && storedNameNorm !== freshNameNorm) {
        disagreements.push({
          fieldClass: "name",
          stored: row.eventName,
          fresh: ev.name,
          notes: `holdout: name drifted on source ("${row.eventName}" → "${ev.name}")`,
        });
      }

      for (const d of disagreements) {
        const id = await captureHoldoutSampleDiscrepancy(db, {
          eventId: row.eventId,
          fieldClass: d.fieldClass,
          storedValue: d.stored,
          refreshValue: d.fresh,
          sourceUrl: row.eventSourceUrl,
          notes: d.notes,
        });
        if (id) result.emitted += 1;
        else result.skipped_dedup += 1;
      }
    }

    console.log(
      `[cron] holdout-sampling ok — sampled=${result.sampled} fetched=${result.fetched} ` +
        `extracted=${result.extracted} emitted=${result.emitted} ` +
        `skipped_dedup=${result.skipped_dedup} errors=${result.errors}`
    );
    return result;
  } catch (error) {
    await logError(db, {
      source: SOURCE,
      message: "holdout-sampling threw unhandled exception",
      error,
    });
    return result;
  }
}

/** Strip non-alphanumeric + lowercase + collapse whitespace. Used for
 *  same-source name comparison (no Levenshtein threshold — see why
 *  inline in the cron body). */
export function simpleNormalize(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** "City, ST" or null when either component is missing. */
export function composeVenue(city: string | null, state: string | null): string | null {
  if (!city || !state) return null;
  const c = city.trim();
  const s = state.trim().toUpperCase();
  if (c.length === 0 || s.length === 0) return null;
  return `${c}, ${s}`;
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isoOrNull(s: string | null | undefined): string | null {
  if (!s) return null;
  const direct = s.match(/^\d{4}-\d{2}-\d{2}/);
  if (direct) return direct[0];
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return toIsoDate(d);
}
