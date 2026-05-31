import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq, and, gte, lte, sql } from "drizzle-orm";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { events, venues } from "@/lib/db/schema";
import { autoLinkVenue } from "@/lib/venue-matching";
import { normalizeName } from "@/lib/duplicates/normalize-name";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { logError } from "@/lib/logger";

export const runtime = "edge";

const checkDuplicateSchema = z.object({
  sourceUrl: z.string().url().optional(),
  name: z.string().optional(),
  startDate: z.string().optional(), // YYYY-MM-DD format
  // K2 (analyst, 2026-05-31): venue signals so dedup matches on
  // place+date rather than name similarity alone. The free-text email
  // submission path leaves venue_id NULL on insert
  // (src/app/api/suggest-event/submit/route.ts:227), so we accept raw
  // venue strings here and resolve via autoLinkVenue internally. Even
  // when resolution fails, (venueCity, venueState) lets us fall back to
  // a venue-join place key — the Winthrop Arts Festival duplicate
  // (PENDING 25ef60f0 vs APPROVED 4ee1de4a) is the canonical case.
  venueName: z.string().optional(),
  venueAddress: z.string().optional(),
  venueCity: z.string().optional(),
  venueState: z.string().optional(),
});

// normalizeName lives in @/lib/duplicates/normalize-name (K2, 2026-05-31)
// so it can be unit-tested directly — Next.js route files reject
// non-handler named exports. Docblock + test fixtures live alongside it.

// Calculate string similarity using Levenshtein distance ratio
function similarity(s1: string, s2: string): number {
  const longer = s1.length > s2.length ? s1 : s2;
  const _shorter = s1.length > s2.length ? s2 : s1;

  if (longer.length === 0) return 1.0;

  const costs: number[] = [];
  for (let i = 0; i <= s1.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= s2.length; j++) {
      if (i === 0) {
        costs[j] = j;
      } else if (j > 0) {
        let newValue = costs[j - 1];
        if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
          newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
        }
        costs[j - 1] = lastValue;
        lastValue = newValue;
      }
    }
    if (i > 0) {
      costs[s2.length] = lastValue;
    }
  }

  const distance = costs[s2.length];
  return (longer.length - distance) / longer.length;
}

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

    const { sourceUrl, name, startDate, venueName, venueAddress, venueCity, venueState } =
      validation.data;
    const db = getCloudflareDb();

    // 1. Check exact URL match
    if (sourceUrl) {
      const exactMatch = await db
        .select({
          id: events.id,
          slug: events.slug,
          name: events.name,
          startDate: events.startDate,
          status: events.status,
          // Returned to the caller so the dedup-enrichment branch (B5
          // Phase 1) can classify whether the incoming source is a
          // higher tier than what's already on file. See src/lib/source-tier.ts.
          sourceUrl: events.sourceUrl,
        })
        .from(events)
        .where(eq(events.sourceUrl, sourceUrl))
        .limit(1);

      if (exactMatch.length > 0) {
        return NextResponse.json({
          success: true,
          isDuplicate: true,
          matchType: "exact_url",
          existingEvent: {
            id: exactMatch[0].id,
            slug: exactMatch[0].slug,
            name: exactMatch[0].name,
            startDate: exactMatch[0].startDate,
            status: exactMatch[0].status,
            sourceUrl: exactMatch[0].sourceUrl,
          },
        });
      }
    }

    // K2 (analyst, 2026-05-31). Pre-compute the ±7-day window once; the
    // venue-date, city-state-date, and name-similarity branches all use it.
    let minDate: Date | null = null;
    let maxDate: Date | null = null;
    if (startDate) {
      const eventDate = new Date(startDate);
      const dateRangeMs = 7 * 24 * 60 * 60 * 1000;
      minDate = new Date(eventDate.getTime() - dateRangeMs);
      maxDate = new Date(eventDate.getTime() + dateRangeMs);
    }

    // 2. Place + date match key (K2 parts 1 + 2 + 3).
    //
    // Place is resolved server-side from the venue strings the caller
    // sent. This makes the email pipeline as strong as the manual
    // suggest_event path — previously the email-handler dedup wire only
    // had {sourceUrl, name, startDate} and silently created duplicates
    // when name strings diverged (the Winthrop "38th Annual…" vs
    // "…Festival 2026" case).
    //
    // Two stages, first hit wins:
    //   2a. venue_date     — autoLinkVenue resolved a venueId, look for
    //                        existing events at that venue ±7d
    //   2b. city_state_date — fall back to venues.city + venues.state
    //                        match ±7d, joining events through venueId
    if (minDate && maxDate && (venueName || (venueCity && venueState))) {
      // Resolve venueId from raw strings. Skips silently when venueName
      // is null/empty; autoLinkVenue handles the no-name branch.
      let resolvedVenueId: string | null = null;
      if (venueName) {
        const linked = await autoLinkVenue(db, {
          venueName,
          venueAddress: venueAddress ?? null,
          venueCity: venueCity ?? null,
          venueState: venueState ?? null,
        });
        // Both "linked" and "address-corroborated" decisions return a
        // confident venueId; "ambiguous" / "no-match" / "no-name" leave
        // it null and we fall through to the city+state branch.
        if (linked.venueId) resolvedVenueId = linked.venueId;
      }

      // Stage 2a — exact venue + date window.
      if (resolvedVenueId) {
        const venueMatch = await db
          .select({
            id: events.id,
            slug: events.slug,
            name: events.name,
            startDate: events.startDate,
            status: events.status,
            sourceUrl: events.sourceUrl,
          })
          .from(events)
          .where(
            and(
              eq(events.venueId, resolvedVenueId),
              gte(events.startDate, minDate),
              lte(events.startDate, maxDate)
            )
          )
          .limit(1);

        if (venueMatch.length > 0) {
          return NextResponse.json({
            success: true,
            isDuplicate: true,
            matchType: "venue_date",
            existingEvent: {
              id: venueMatch[0].id,
              slug: venueMatch[0].slug,
              name: venueMatch[0].name,
              startDate: venueMatch[0].startDate,
              status: venueMatch[0].status,
              sourceUrl: venueMatch[0].sourceUrl,
            },
          });
        }
      }

      // Stage 2b — venue couldn't be resolved (or didn't find anything
      // at that venue), but we still have city + state. Join through
      // venues and match on canonical city/state. Captures the
      // Winthrop case where the existing approved event has a venueId
      // pointing at the Winthrop venue and the incoming free-text
      // submission only carries the raw venueCity/venueState strings.
      if (venueCity && venueState) {
        const normalizedCity = venueCity.trim();
        const normalizedState = venueState.trim().toUpperCase();
        const cityStateMatch = await db
          .select({
            id: events.id,
            slug: events.slug,
            name: events.name,
            startDate: events.startDate,
            status: events.status,
            sourceUrl: events.sourceUrl,
          })
          .from(events)
          .innerJoin(venues, eq(events.venueId, venues.id))
          .where(
            and(
              // Case-insensitive city match via LOWER() — venue rows from
              // different ingestion paths can disagree on capitalization
              // (e.g. "Winthrop" vs "winthrop").
              sql`LOWER(${venues.city}) = LOWER(${normalizedCity})`,
              eq(venues.state, normalizedState),
              gte(events.startDate, minDate),
              lte(events.startDate, maxDate)
            )
          )
          .limit(1);

        if (cityStateMatch.length > 0) {
          return NextResponse.json({
            success: true,
            isDuplicate: true,
            matchType: "city_state_date",
            existingEvent: {
              id: cityStateMatch[0].id,
              slug: cityStateMatch[0].slug,
              name: cityStateMatch[0].name,
              startDate: cityStateMatch[0].startDate,
              status: cityStateMatch[0].status,
              sourceUrl: cityStateMatch[0].sourceUrl,
            },
          });
        }
      }
    }

    // 3. Check name + date similarity (legacy tiebreaker, retained when
    //    no place key is available). Still useful for body-only or
    //    no-venue submissions where the place can't be resolved.
    if (name && startDate && minDate && maxDate) {
      const normalizedName = normalizeName(name);

      const similarEvents = await db
        .select({
          id: events.id,
          slug: events.slug,
          name: events.name,
          startDate: events.startDate,
          status: events.status,
          sourceUrl: events.sourceUrl,
        })
        .from(events)
        .where(and(gte(events.startDate, minDate), lte(events.startDate, maxDate)));

      // Check string similarity with threshold
      const threshold = 0.85;
      for (const event of similarEvents) {
        if (!event.name) continue;

        const existingNormalized = normalizeName(event.name);
        const sim = similarity(normalizedName, existingNormalized);

        if (sim > threshold) {
          return NextResponse.json({
            success: true,
            isDuplicate: true,
            matchType: "similar_name_date",
            similarity: Math.round(sim * 100),
            existingEvent: {
              id: event.id,
              slug: event.slug,
              name: event.name,
              startDate: event.startDate,
              status: event.status,
              sourceUrl: event.sourceUrl,
            },
          });
        }
      }
    }

    // No duplicate found
    return NextResponse.json({
      success: true,
      isDuplicate: false,
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
