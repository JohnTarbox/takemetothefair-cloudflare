export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { events, promoters, eventSchemaOrg } from "@/lib/db/schema";
import { parseJsonLd } from "@/lib/schema-org";
import { eq } from "drizzle-orm";
import { createSlug, computePublicDates, dollarsToCents, unsafeSlug } from "@/lib/utils";
import { resolveUniqueEventSlug, insertEventDaysBatched } from "@/lib/events/insert-helpers";
import { logError } from "@/lib/logger";
import { recomputeEventCompleteness } from "@/lib/completeness";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { evaluateGates } from "@/lib/event-date-gates";
import { verifyTurnstileToken, getTurnstileErrorMessage } from "@/lib/turnstile";
import { auth } from "@/lib/auth";
import { inferCategoriesFromName } from "@/lib/url-import/infer-categories";
import { loadClassifications, gateUrlForField } from "@/lib/url-classification";
import { PUBLIC_EVENT_STATUSES } from "@/lib/constants";
import { classifySource } from "@/lib/source-classification";
import { pingIndexNow, indexNowUrlFor } from "@/lib/indexnow";
import { autoLinkVenue, deriveStateFromText } from "@/lib/venue-matching";
import { normalizeEventDate } from "@/lib/event-dates";
import { areDatesContiguous } from "@takemetothefair/utils";
import { maybeRouteToOccurrence } from "@/lib/discovery/route-to-occurrence";
import { submitEventSchema } from "./schema";

const PUBLIC_EVENT_SET = new Set<string>(PUBLIC_EVENT_STATUSES);

// The stable ID for the Community Suggestions promoter
const COMMUNITY_PROMOTER_ID = "system-community-suggestions";

export async function POST(request: NextRequest) {
  // Internal callers (MCP Worker email handler, future cross-service hooks)
  // present `X-Internal-Key` matching INTERNAL_API_KEY. They've already done
  // their own gating (per-sender rate limit, CF Email Routing spam filter),
  // so we skip IP rate limit + Turnstile. Same pattern as the admin routes
  // that accept MCP-server writes (see admin/vendors/[id]/route.ts).
  const internalKey = request.headers.get("x-internal-key");
  const cfEnv = getCloudflareEnv() as unknown as { INTERNAL_API_KEY?: string };
  const isInternal = !!(
    internalKey &&
    cfEnv.INTERNAL_API_KEY &&
    internalKey === cfEnv.INTERNAL_API_KEY
  );

  let rateLimitResult: Awaited<ReturnType<typeof checkRateLimit>> | null = null;
  if (!isInternal) {
    rateLimitResult = await checkRateLimit(request, "suggest-event-submit");
    if (!rateLimitResult.allowed) {
      return rateLimitResponse(rateLimitResult);
    }
  }

  const db = getCloudflareDb();

  try {
    const body = await request.json();
    const validation = submitEventSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { success: false, error: validation.error.issues[0]?.message || "Validation failed" },
        { status: 400 }
      );
    }

    const data = validation.data;

    // Check auth for authenticated submissions
    const session = await auth();
    if (session?.user?.id && !data.submittedByUserId) {
      data.submittedByUserId = session.user.id;
    }

    // Verify Turnstile token for anonymous, non-internal callers.
    if (!isInternal && rateLimitResult && !rateLimitResult.isAuthenticated) {
      const turnstileResult = await verifyTurnstileToken(data.turnstileToken || "", request);
      if (!turnstileResult.success) {
        return NextResponse.json(
          {
            success: false,
            error: getTurnstileErrorMessage(turnstileResult.errorCodes),
          },
          { status: 400 }
        );
      }
    }

    // Verify the community promoter exists
    const promoter = await db
      .select()
      .from(promoters)
      .where(eq(promoters.id, COMMUNITY_PROMOTER_ID))
      .limit(1);

    if (promoter.length === 0) {
      // Create it if it doesn't exist (for non-seeded databases)
      await db.insert(promoters).values({
        id: COMMUNITY_PROMOTER_ID,
        userId: null,
        companyName: "Community Suggestions",
        slug: unsafeSlug("community-suggestions"),
        description: "Events suggested by the community. These events are pending admin review.",
        verified: false,
      });
    }

    // Generate event slug. WS2a — shared prefix-range resolver (was a
    // per-candidate while-loop; now `base-2` first on collision, not `base-1`).
    const eventSlug = createSlug(data.name);
    const finalEventSlug = await resolveUniqueEventSlug(db, eventSlug);

    // Parse dates. Normalize bare YYYY-MM-DD (and YYYY-MM-DDT00:00:00Z) to
    // noon UTC — midnight-UTC dates render as the PREVIOUS calendar day in
    // every US timezone (midnight UTC = 8pm EDT/EST yesterday, 4pm PDT
    // yesterday). Noon UTC = 8am EDT / 5am PST → same calendar day site-
    // wide. AI extraction returns YYYY-MM-DD which `new Date()` parses as
    // midnight UTC by default; this normalization shifts that to noon
    // before insert. See drizzle/0074_event_dates_noon_utc.sql for the
    // matching backfill against ~751 pre-existing midnight-UTC rows.
    const startDate = normalizeEventDate(data.startDate ?? null);
    const endDate = normalizeEventDate(data.endDate ?? null);

    // Build description with location info if provided
    let description = data.description || `${data.name} - suggested by the community`;
    if (data.venueName || data.venueCity) {
      const locationParts: string[] = [];
      if (data.venueName) locationParts.push(data.venueName);
      if (data.venueAddress) locationParts.push(data.venueAddress);
      if (data.venueCity) locationParts.push(data.venueCity);
      if (data.venueState) locationParts.push(data.venueState);
      if (locationParts.length > 0 && !description.includes(locationParts[0])) {
        description += `\n\nLocation: ${locationParts.join(", ")}`;
      }
    }

    // Determine status: vendor submissions get TENTATIVE (publicly visible),
    // community + email submissions get PENDING (hidden until admin approves).
    // Lifecycle pairs with editorial: vendor submissions are TENTATIVE-lifecycle
    // (dates unconfirmed at submission time); all others default to SCHEDULED.
    const baseEventStatus = data.source === "vendor" ? "TENTATIVE" : "PENDING";
    const eventLifecycle: "TENTATIVE" | "SCHEDULED" =
      data.source === "vendor" ? "TENTATIVE" : "SCHEDULED";
    const sourceName =
      data.source === "vendor"
        ? "vendor-submission"
        : data.source === "email"
          ? "email-submission"
          : "community-suggestion";

    // Pre-ingest date-quality gates. Community/vendor/email submissions can include
    // arbitrary source URLs, so evaluateGates may downgrade TENTATIVE-vendor
    // submissions to PENDING if a name/date pattern fires. (PENDING submissions
    // already hit PENDING — gate just adds the trace flags.)
    const gateResult = evaluateGates({
      name: data.name,
      sourceUrl: data.sourceUrl ?? null,
      sourceName,
      startDate,
      endDate,
      applicationDeadline: null,
      description,
      eventScale: data.eventScale ?? null,
    });
    const gateReasons = [...gateResult.reasons];
    let gateRoute = gateResult.route;

    // Past-date guard: never auto-publish a submission whose startDate is
    // already in the past at ingest time. The AI extractor will occasionally
    // pick a season-start string from a linked form (e.g. "Every other
    // Saturday beginning 4/11/2026") instead of the future dates listed in
    // the submitter's email body — producing a past-dated PENDING/TENTATIVE
    // row that pollutes the public listings and wastes admin review time.
    // Force PENDING + flag for human review.
    if (startDate && startDate.getTime() < Date.now()) {
      gateRoute = "PENDING_REVIEW";
      if (!gateReasons.includes("past_date")) gateReasons.push("past_date");
    }

    const eventStatus = gateRoute === "PENDING_REVIEW" ? "PENDING" : baseEventStatus;
    const gateFlagsJson = gateReasons.length > 0 ? JSON.stringify(gateReasons) : null;
    const tagList: string[] =
      data.source === "vendor"
        ? ["community-suggestion", "vendor-submission"]
        : data.source === "email"
          ? ["community-suggestion", "email-submission"]
          : ["community-suggestion"];

    // Gate URLs against the domain classification table — community/vendor
    // submissions can include arbitrary URLs, so we filter aggregator domains
    // out of ticket_url and application_url before insert.
    const urlClassifications = await loadClassifications(db);
    const gatedTicketUrl = gateUrlForField(
      data.ticketUrl || data.sourceUrl || null,
      "ticket",
      urlClassifications
    );
    const gatedApplicationUrl = gateUrlForField(
      data.applicationUrl ?? null,
      "application",
      urlClassifications
    );

    // Venue auto-link: if the caller provided a venue NAME but no
    // venue_id (the common case for email/community submissions where
    // AI extraction returned a venue string), try to resolve it
    // against the venues table. Conservative — only auto-links on
    // exact normalized-name match (with optional state agreement) or
    // address-corroborated near-match. Ambiguous and no-match cases
    // leave venue_id NULL for admin review. See src/lib/venue-matching.ts.
    let resolvedVenueId: string | null = data.venueId || null;
    let resolvedStateCode: string | null = data.venueState
      ? data.venueState.trim().toUpperCase()
      : null;
    if (!resolvedVenueId && data.venueName) {
      const result = await autoLinkVenue(db, {
        venueName: data.venueName,
        venueAddress: data.venueAddress ?? null,
        venueCity: data.venueCity ?? null,
        venueState: data.venueState ?? null,
      });
      resolvedVenueId = result.venueId;
      // Inherit state from matched venue when present; fall through to
      // any state we already had (extracted/AI) when no venue matched.
      resolvedStateCode = result.stateCode ?? resolvedStateCode;
    }
    // Last resort: if we still don't have a state, scan the description
    // for a single NE-state mention. One unique state → use it. Multiple
    // (or none) → keep null and let admin fill in.
    if (!resolvedStateCode) {
      resolvedStateCode = deriveStateFromText(description);
    }

    // Expand `specificDates` (recurring/multi-date) into eventDays rows when
    // the caller didn't already provide an eventDays payload. Lets the
    // inbound-email pipeline ship cadence-expanded events without having to
    // construct the eventDays array itself.
    interface NormalizedDay {
      date: string;
      // DQ4: null = "hours not yet confirmed." Schema column is also
      // nullable as of drizzle/0118 — this type now matches.
      openTime: string | null;
      closeTime: string | null;
      notes?: string | null;
      closed?: boolean;
      vendorOnly?: boolean;
    }
    const effectiveEventDays: NormalizedDay[] | null =
      data.eventDays && data.eventDays.length > 0
        ? data.eventDays.map((d) => ({
            date: d.date,
            // DQ4 (2026-06-08): preserve null hours coming up from the
            // validation layer rather than rewriting them to a fabricated
            // default. The event-side write below sets flaggedForReview=1
            // when any per-day row lands without explicit hours.
            openTime: d.openTime ?? null,
            closeTime: d.closeTime ?? null,
            notes: d.notes ?? null,
            closed: d.closed ?? false,
            vendorOnly: d.vendorOnly ?? false,
          }))
        : data.specificDates && data.specificDates.length > 0
          ? data.specificDates.map((date) => ({
              date,
              // DQ4: was `data.startTime || "10:00"` / `|| "18:00"` —
              // fabricating times the source page never exposed. Now
              // pass through null when the form/extract didn't capture
              // the value; render layer surfaces "Hours not yet confirmed."
              openTime: data.startTime || null,
              closeTime: data.endTime || null,
            }))
          : null;

    // OPE-47 (2026-07): derive the discontinuous flag from ACTUAL date
    // contiguity, not a bare day count. Previously any event with ≥2
    // event_days was marked discontinuous — which over-flagged a genuinely
    // consecutive multi-day run (a 3-day fair) and stripped its "Daily:"
    // label, and under-flagging arose elsewhere for the same reason. The
    // stored flag is now exactly `!areDatesContiguous(dates)` so it agrees
    // with the display's "Daily:" gate (isContiguousDaily) by construction.
    // An explicit submitter-set discontinuousDates=true is still honored as
    // an override.
    const generatedDayDates =
      effectiveEventDays !== null ? effectiveEventDays.map((d) => d.date) : [];
    const finalDiscontinuous =
      data.discontinuousDates === true ||
      (generatedDayDates.length >= 2 && !areDatesContiguous(generatedDayDates));

    // DQ4 (2026-06-08): when any event_day row lands without hours,
    // flag the parent event for operator triage. The /admin/events?flagged=1
    // queue is the surface; operators backfill from the source page and
    // clear the flag once the times are known.
    const anyHoursUnknown =
      effectiveEventDays !== null &&
      effectiveEventDays.some((d) => d.openTime == null || d.closeTime == null);

    // When discontinuous, align startDate/endDate with the first and last
    // occurrence so the public range matches the actual schedule.
    let effectiveStartDate = startDate;
    let effectiveEndDate = endDate;
    if (finalDiscontinuous && effectiveEventDays && effectiveEventDays.length > 0) {
      const sortedDates = effectiveEventDays.map((d) => d.date).sort();
      effectiveStartDate = normalizeEventDate(sortedDates[0]);
      effectiveEndDate = normalizeEventDate(sortedDates[sortedDates.length - 1]);
    }

    // K34 / EH3 P3.3b — if this submission is really a new EDITION of an
    // existing event that belongs to a SERIES (different year), attach it as an
    // occurrence under that series instead of minting a year-suffixed standalone
    // (the cheshire-fair-nh-2027 class). INERT until the P1 backfill sets
    // series_id: until then any findDuplicate hit has no series, so this returns
    // routed:false and we fall through to the standalone insert below unchanged.
    const occRoute = await maybeRouteToOccurrence(db, {
      name: data.name,
      startDate: effectiveStartDate,
      endDate: effectiveEndDate,
      venueId: resolvedVenueId,
      sourceUrl: data.sourceUrl ?? null,
      venueName: data.venueName ?? null,
      venueAddress: data.venueAddress ?? null,
      venueCity: data.venueCity ?? null,
      venueState: data.venueState ?? null,
      actorUserId: data.submittedByUserId ?? null,
    });
    if (occRoute.routed) {
      const r = occRoute.result;
      if (r.created) {
        return NextResponse.json({
          success: true,
          routed: "occurrence",
          event: { id: r.occurrenceId, slug: r.slug, name: data.name },
          year: r.year,
        });
      }
      if (r.reason === "occurrence_exists") {
        // The edition already exists under the series — don't create a sibling.
        return NextResponse.json({
          success: true,
          routed: "occurrence_exists",
          event: { id: r.existingEventId, name: data.name },
          year: r.year,
        });
      }
      // series_not_found / promoter_required: fall through to the standalone
      // insert (safe default — better a standalone row than a dropped submission).
    }

    // Create the event
    const newEventId = crypto.randomUUID();
    await db.insert(events).values({
      id: newEventId,
      name: data.name,
      slug: finalEventSlug,
      description,
      promoterId: COMMUNITY_PROMOTER_ID,
      venueId: resolvedVenueId,
      stateCode: resolvedStateCode,
      startDate: effectiveStartDate,
      endDate: effectiveEndDate,
      discontinuousDates: finalDiscontinuous,
      publicStartDate:
        effectiveEventDays && effectiveEventDays.length > 0
          ? computePublicDates(effectiveEventDays).publicStartDate
          : effectiveStartDate,
      publicEndDate:
        effectiveEventDays && effectiveEventDays.length > 0
          ? computePublicDates(effectiveEventDays).publicEndDate
          : effectiveEndDate,
      datesConfirmed: effectiveStartDate !== null,
      categories: JSON.stringify(
        Array.isArray(data.categories) && data.categories.length > 0
          ? data.categories
          : (inferCategoriesFromName(data.name) ?? ["Event"])
      ),
      tags: JSON.stringify(tagList),
      ticketUrl: gatedTicketUrl,
      ticketPriceMinCents: dollarsToCents(data.ticketPriceMin),
      ticketPriceMaxCents: dollarsToCents(data.ticketPriceMax),
      imageUrl: data.imageUrl || null,
      status: eventStatus,
      gateFlags: gateFlagsJson,
      lifecycleStatus: eventLifecycle,
      sourceName,
      // Three suggest_event variants (vendor / email / community) map to
      // three distinct ingestion methods via the classifier's label table.
      // sourceDomain comes from data.sourceUrl when the submitter included one.
      sourceDomain: classifySource(sourceName, data.sourceUrl).sourceDomain,
      ingestionMethod:
        classifySource(sourceName, data.sourceUrl).ingestionMethod ?? "community_suggestion",
      sourceUrl: data.sourceUrl || null,
      sourceId: data.sourceUrl ? createSlug(data.sourceUrl) : newEventId,
      syncEnabled: false,
      lastSyncedAt: new Date(),
      suggesterEmail: data.suggesterEmail || null,
      submittedByUserId: data.submittedByUserId || null,
      vendorFeeMinCents: dollarsToCents(data.vendorFeeMin),
      vendorFeeMaxCents: dollarsToCents(data.vendorFeeMax),
      vendorFeeNotes: data.vendorFeeNotes ?? null,
      indoorOutdoor: data.indoorOutdoor ?? null,
      estimatedAttendance: data.estimatedAttendance ?? null,
      eventScale: data.eventScale ?? null,
      applicationUrl: gatedApplicationUrl,
      // OPE-198 — vendor-application deadline (date-only) + apply instructions.
      applicationDeadline: normalizeEventDate(data.applicationDeadline ?? null),
      applicationInstructions: data.applicationInstructions ?? null,
      walkInsAllowed: data.walkInsAllowed ?? null,
      // Cohort 2 (2026-06-01) — populated when the inbound-email workflow
      // detected a MEDIUM-confidence dedup hit. NULL on every other path.
      possibleDuplicateOf: data.possibleDuplicateOf ?? null,
      // DQ4: flag for review when any event_day row carries NULL hours.
      // Operator triage queue at /admin/events?flagged=1.
      flaggedForReview: anyHoursUnknown ? 1 : 0,
    });

    await recomputeEventCompleteness(db, newEventId);

    // Insert event days from whichever input provided them (explicit
    // eventDays payload or specificDates expansion above). D1 caps each
    // statement at 100 bound parameters; event_days rows pass 9 columns
    // (8 explicit + the $defaultFn createdAt), so chunks are capped at 11
    // rows (11 × 9 = 99). Recurring events easily exceed the safe count —
    // 582f3156 had 16 — so the loop is required, not optional.
    // WS2a — shared D1-safe batched insert (was an inline chunk loop).
    await insertEventDaysBatched(db, newEventId, effectiveEventDays);

    // Store schema.org data if JSON-LD was provided
    if (data.jsonLd) {
      try {
        const parseResult = parseJsonLd(data.jsonLd);
        const now = new Date();
        const ticketUrl = data.ticketUrl || data.sourceUrl || null;

        await db.insert(eventSchemaOrg).values({
          id: crypto.randomUUID(),
          eventId: newEventId,
          ticketUrl,
          rawJsonLd: parseResult.rawJsonLd,
          schemaName: parseResult.data?.name || null,
          schemaDescription: parseResult.data?.description || null,
          schemaStartDate: parseResult.data?.startDate || null,
          schemaEndDate: parseResult.data?.endDate || null,
          schemaVenueName: parseResult.data?.venueName || null,
          schemaVenueAddress: parseResult.data?.venueAddress || null,
          schemaVenueCity: parseResult.data?.venueCity || null,
          schemaVenueState: parseResult.data?.venueState || null,
          schemaVenueLat: parseResult.data?.venueLat || null,
          schemaVenueLng: parseResult.data?.venueLng || null,
          schemaImageUrl: parseResult.data?.imageUrl || null,
          schemaTicketUrl: parseResult.data?.ticketUrl || null,
          schemaPriceMinCents: dollarsToCents(parseResult.data?.priceMin),
          schemaPriceMaxCents: dollarsToCents(parseResult.data?.priceMax),
          schemaEventStatus: parseResult.data?.eventStatus || null,
          schemaOrganizerName: parseResult.data?.organizerName || null,
          schemaOrganizerUrl: parseResult.data?.organizerUrl || null,
          status: parseResult.status,
          lastFetchedAt: now,
          lastError: parseResult.error || null,
          fetchCount: 1,
          createdAt: now,
          updatedAt: now,
        });
      } catch (schemaError) {
        // Non-blocking: event still created without schema.org data.
        // Routes through logError so the failure surfaces in /admin/logs.
        await logError(db, {
          message: "Failed to store schema.org data during suggest-event submit",
          error: schemaError,
          source: "suggest-event-submit",
          request,
        });
      }
    }

    // IndexNow: vendor submissions land as TENTATIVE (publicly visible) and
    // bypass the PATCH-based hooks. Ping for those; PENDING community
    // suggestions stay non-public until an admin promotes them.
    if (PUBLIC_EVENT_SET.has(eventStatus)) {
      const cfEnv = getCloudflareEnv() as unknown as { INDEXNOW_KEY?: string };
      await pingIndexNow(db, indexNowUrlFor("events", finalEventSlug), cfEnv, "event-create");
    }

    return NextResponse.json({
      success: true,
      event: {
        id: newEventId,
        slug: finalEventSlug,
        name: data.name,
      },
    });
  } catch (error) {
    await logError(db, {
      message: "Error submitting event suggestion",
      error,
      source: "api/suggest-event/submit",
      request,
    });
    return NextResponse.json(
      { success: false, error: "Failed to submit event suggestion. Please try again." },
      { status: 500 }
    );
  }
}
