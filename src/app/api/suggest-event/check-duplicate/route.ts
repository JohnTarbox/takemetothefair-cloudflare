export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { events, venues } from "@/lib/db/schema";
import { findDuplicate } from "@/lib/duplicates/find-duplicate";
import { compareForIngest } from "@/lib/goodwill/ingest-discrepancy";
import {
  lookupReliability,
  decideResolution,
  formatResolutionNotes,
} from "@/lib/goodwill/reliability-resolution";
import { flipEventField } from "@/lib/goodwill/flip-event-field";
import { getFlipMargin } from "@/lib/goodwill/get-flip-margin";
import { enqueueIngestDiscrepancy } from "@/lib/queues/producers";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { logError } from "@/lib/logger";

// All matching logic lives in @/lib/duplicates/find-duplicate.ts so it
// can be reused by the email pipeline's enrich-or-flag step (K2 part 5)
// and the dedup sweep endpoint (K2 part 6). The route is the thin
// HTTP wrapper: rate-limit + INTERNAL_API_KEY auth + body validation,
// then delegate to findDuplicate. K2 part 4, analyst 2026-05-31.

const checkDuplicateSchema = z.object({
  sourceUrl: z.string().url().optional(),
  name: z.string().optional(),
  startDate: z.string().optional(), // YYYY-MM-DD format
  // Venue signals — resolved server-side inside findDuplicate via
  // autoLinkVenue, then used for the venue_date and city_state_date
  // match stages.
  venueName: z.string().optional(),
  venueAddress: z.string().optional(),
  venueCity: z.string().optional(),
  venueState: z.string().optional(),
});

export async function POST(request: NextRequest) {
  // Internal callers (MCP Worker email pipeline, future cross-service hooks)
  // present `X-Internal-Key` matching INTERNAL_API_KEY. They've already gated
  // on their own per-sender / per-tier limits, so skip the IP-based rate limit
  // here. Same pattern as /api/suggest-event/submit's internal-key bypass.
  const internalKey = request.headers.get("x-internal-key");
  const cfEnv = getCloudflareEnv() as unknown as { INTERNAL_API_KEY?: string };
  const isInternal = !!(
    internalKey &&
    cfEnv.INTERNAL_API_KEY &&
    internalKey === cfEnv.INTERNAL_API_KEY
  );

  if (!isInternal) {
    const rateLimitResult = await checkRateLimit(request, "suggest-event-check-duplicate");
    if (!rateLimitResult.allowed) {
      return rateLimitResponse(rateLimitResult);
    }
  }

  try {
    const body = await request.json();
    const validation = checkDuplicateSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { success: false, error: validation.error.issues[0]?.message || "Validation failed" },
        { status: 400 }
      );
    }

    const db = getCloudflareDb();
    const result = await findDuplicate(db, validation.data);

    if (!result.isDuplicate) {
      return NextResponse.json({ success: true, isDuplicate: false });
    }

    // GW1.1 (2026-06-03) — ingest_addverify discrepancy capture.
    // On stages-2-4 matches, fetch the full existing-event row (the
    // slim ExistingEvent returned by findDuplicate is missing endDate /
    // venueId / venue city+state / sourceDomain — see find-duplicate.ts
    // :62-69), run the field comparator, and enqueue one discrepancy
    // message per disagreeing field. Fire-and-forget via the producer's
    // own waitUntil — the route response shape is unchanged.
    //
    // Stage 1 (exact_url) is skipped at the comparator boundary; we
    // additionally early-skip here to avoid a wasted PK lookup.
    if (result.matchType !== "exact_url" && validation.data.sourceUrl) {
      enqueueDiscrepanciesAsync(
        result.matchType,
        result.existingEvent.id,
        validation.data,
        db
      ).catch(() => {
        // The producer logs internally on every failure mode; this
        // catch only guards against an unexpected throw from the
        // outer Promise so the route response is never blocked.
      });
    }

    // similarity is only set on similar_name_date and is expressed as
    // a percent in the legacy wire shape for backwards compat with
    // the email pipeline's reply templates.
    return NextResponse.json({
      success: true,
      isDuplicate: true,
      matchType: result.matchType,
      ...(result.matchType === "similar_name_date" && result.similarity !== undefined
        ? { similarity: Math.round(result.similarity * 100) }
        : {}),
      existingEvent: {
        id: result.existingEvent.id,
        slug: result.existingEvent.slug,
        name: result.existingEvent.name,
        startDate: result.existingEvent.startDate,
        status: result.existingEvent.status,
        sourceUrl: result.existingEvent.sourceUrl,
      },
    });
  } catch (error) {
    await logError(getCloudflareDb(), {
      message: "Check-duplicate route failure",
      error,
      source: "suggest-event-check-duplicate",
      request,
      statusCode: 500,
    });
    return NextResponse.json(
      { success: false, error: "Failed to check for duplicates" },
      { status: 500 }
    );
  }
}

/**
 * GW1.1 emit helper — fetch the full existing-event row, run the
 * comparator, and enqueue one IngestDiscrepancyMessage per disagreement.
 *
 * Pulled out of the main handler so the route flow stays readable. All
 * I/O is `try { ... } catch { log + return }` — never throws to the
 * caller because the caller's invocation is via `.catch(()=>{})` and a
 * surfaced error would only end up in unhandled-rejection logs, not in
 * a useful audit row.
 */
async function enqueueDiscrepanciesAsync(
  matchType: import("@/lib/duplicates/find-duplicate").MatchType,
  existingEventId: string,
  candidate: {
    sourceUrl?: string;
    name?: string;
    startDate?: string;
    venueCity?: string;
    venueState?: string;
  },
  db: ReturnType<typeof getCloudflareDb>
): Promise<void> {
  try {
    // Re-fetch with a LEFT JOIN on venues for city/state. Single PK
    // lookup + one join — same shape as the K-bundle's merge-events
    // path, cheap enough on D1.
    const rows = await db
      .select({
        id: events.id,
        name: events.name,
        startDate: events.startDate,
        endDate: events.endDate,
        venueId: events.venueId,
        sourceUrl: events.sourceUrl,
        sourceDomain: events.sourceDomain,
        venueCity: venues.city,
        venueState: venues.state,
      })
      .from(events)
      .leftJoin(venues, eq(events.venueId, venues.id))
      .where(eq(events.id, existingEventId))
      .limit(1);

    if (rows.length === 0) {
      // Race: existing event vanished between findDuplicate and now.
      // Drop silently — there's nothing meaningful to emit against.
      return;
    }
    const row = rows[0];

    const disagreements = compareForIngest(
      matchType,
      {
        name: candidate.name ?? null,
        startDate: candidate.startDate ?? null,
        venueCity: candidate.venueCity ?? null,
        venueState: candidate.venueState ?? null,
        sourceUrl: candidate.sourceUrl ?? "",
      },
      {
        id: row.id,
        name: row.name,
        startDate: row.startDate,
        endDate: row.endDate,
        venueId: row.venueId,
        venueCity: row.venueCity,
        venueState: row.venueState,
        sourceUrl: row.sourceUrl,
        sourceDomain: row.sourceDomain,
      }
    );

    if (disagreements.length === 0) return;

    // Derive the divergent source key from the candidate's sourceUrl,
    // since the producer message wants both the URL and the lowercased
    // domain key for index-friendly source rollups (GW1c's per-source
    // reliability scorer joins on `source_key`).
    const divergentSourceKey = safeHostFromUrl(candidate.sourceUrl ?? null);
    const divergentSourceUrl = candidate.sourceUrl ?? null;

    // GW1.2 (2026-06-03) — reliability-weighted resolution. Per
    // disagreeing field: look up both sources' accuracy posteriors,
    // decide winner by a configurable margin (default 0.2, tunable
    // via goodwill_config row id=1 per G remainder 2026-06-05). Below
    // margin or on unknown source → log decision in notes, keep
    // existing value (default). At/above margin with winner=candidate
    // → either FLIP the stored value via flipEventField (when the
    // GOODWILL_FLIP_ENABLED env flag is set) or log a 'would_flip'
    // shadow note. Spec requires the discrepancy to be emitted in
    // all cases — the decision augments notes, never gates emit.
    const flipEnabled =
      (getCloudflareEnv() as unknown as { GOODWILL_FLIP_ENABLED?: string })
        .GOODWILL_FLIP_ENABLED === "1";
    // Read the flip margin once per request — cheap (single-row table)
    // and avoids per-disagreement query amplification on multi-field
    // discrepancies.
    const flipMargin = await getFlipMargin(db);

    for (const d of disagreements) {
      let resolutionNotes = "";
      try {
        // hours/status/price/existence aren't yielded by compareForIngest
        // today, but the type permits them — narrow defensively.
        if (d.fieldClass === "date" || d.fieldClass === "venue" || d.fieldClass === "name") {
          const [candRel, existRel] = await Promise.all([
            lookupReliability(db, divergentSourceKey, d.fieldClass),
            lookupReliability(db, row.sourceDomain, d.fieldClass),
          ]);
          const decision = decideResolution({
            fieldClass: d.fieldClass,
            candidateSourceKey: divergentSourceKey,
            existingSourceKey: row.sourceDomain,
            candidateScore: candRel?.score ?? null,
            existingScore: existRel?.score ?? null,
            flipEnabled,
            margin: flipMargin,
          });
          resolutionNotes = formatResolutionNotes(decision);

          // Flip only when: decision.reason === 'flipped' (margin met
          // AND flag set), winner = candidate, and the field is one we
          // know how to write (date or name — venue deferred).
          if (
            decision.reason === "flipped" &&
            decision.winner === "candidate" &&
            d.divergentValue &&
            (d.fieldClass === "date" || d.fieldClass === "name")
          ) {
            try {
              const flipResult = await flipEventField(db, {
                eventId: row.id,
                fieldClass: d.fieldClass,
                newValue: d.divergentValue,
                sourceUrl: candidate.sourceUrl ?? "",
                sourceType: "other",
                notes: `gw1.2 flip from ${row.sourceDomain ?? "unknown"} → ${divergentSourceKey ?? "unknown"}`,
              });
              if (!flipResult) {
                // Parse failure — record in notes so the emit captures it.
                resolutionNotes += " [flip-skipped: parse-failed]";
              }
            } catch (flipErr) {
              await logError(db, {
                level: "warn",
                source: "suggest-event-check-duplicate:gw1.2-flip",
                message: "flipEventField threw",
                error: flipErr,
                context: { eventId: row.id, fieldClass: d.fieldClass },
              });
              resolutionNotes += " [flip-failed: see-error-logs]";
            }
          }
        }
      } catch (resErr) {
        // Resolution failure is non-fatal — emit the discrepancy with
        // a marker so the scorer can see we tried but couldn't decide.
        resolutionNotes = " [gw1.2 resolution-error]";
        await logError(db, {
          level: "warn",
          source: "suggest-event-check-duplicate:gw1.2-resolve",
          message: "reliability-resolution threw",
          error: resErr,
          context: { eventId: row.id, fieldClass: d.fieldClass },
        });
      }

      await enqueueIngestDiscrepancy({
        detectedBy: "ingest_addverify",
        eventId: row.id,
        fieldClass: d.fieldClass,
        authoritativeValue: d.authoritativeValue,
        authoritativeSourceKey: row.sourceDomain,
        authoritativeSourceUrl: row.sourceUrl,
        divergentValue: d.divergentValue,
        divergentSourceKey,
        divergentSourceUrl,
        confidence: 0.85,
        notes: d.notes + resolutionNotes,
      });
    }
  } catch (err) {
    await logError(db, {
      level: "warn",
      source: "suggest-event-check-duplicate:ingest-addverify",
      message: "enqueueDiscrepanciesAsync threw",
      error: err,
      context: { existingEventId, matchType },
    });
  }
}

function safeHostFromUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}
