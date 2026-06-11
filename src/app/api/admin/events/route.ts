export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { events, contentLinks, blogPosts, venues } from "@/lib/db/schema";
import { eq, and, sql, inArray } from "drizzle-orm";
import { createSlug, computePublicDates, dollarsToCents, unsafeSlug } from "@/lib/utils";
import { resolveUniqueEventSlug, insertEventDaysBatched } from "@/lib/events/insert-helpers";
import { getEventsWithRelations } from "@/lib/queries";
import { eventCreateSchema, validateRequestBody } from "@/lib/validations";
import { logError } from "@/lib/logger";
import { PUBLIC_EVENT_STATUSES } from "@/lib/constants";
import { classifySource } from "@/lib/source-classification";
import { parseDateOnly } from "@/lib/datetime";
import { normalizeEventDate } from "@/lib/event-dates";
import { pingIndexNow, indexNowUrlFor } from "@/lib/indexnow";
import { recomputeEventCompleteness } from "@/lib/completeness";
import { evaluateGates } from "@/lib/event-date-gates";

const PUBLIC_EVENT_SET = new Set<string>(PUBLIC_EVENT_STATUSES);

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const searchParams = request.nextUrl.searchParams;
  const status = searchParams.get("status");

  const db = getCloudflareDb();
  try {
    const eventsList = await getEventsWithRelations(db, {
      status: status || undefined,
      includeVendorCounts: true,
    });

    // One aggregated query for blog-post counts per event, joined in memory.
    const blogCounts = await db
      .select({
        eventId: contentLinks.targetId,
        n: sql<number>`count(distinct ${contentLinks.sourceId})`,
      })
      .from(contentLinks)
      .innerJoin(blogPosts, eq(contentLinks.sourceId, blogPosts.id))
      .where(
        and(
          eq(contentLinks.sourceType, "BLOG_POST"),
          eq(contentLinks.targetType, "EVENT"),
          eq(blogPosts.status, "PUBLISHED")
        )
      )
      .groupBy(contentLinks.targetId);
    const byEvent = new Map(
      blogCounts
        .filter((r): r is { eventId: string; n: number } => !!r.eventId)
        .map((r) => [r.eventId, Number(r.n)])
    );

    // Cohort 2 (analyst, 2026-06-01) — fetch candidate-event metadata
    // for any rows with possible_duplicate_of set (MEDIUM-confidence
    // dedup hits flagged by the inbound-email workflow). Batched into
    // a single inArray query, then attached as `possibleDuplicate` so
    // the admin UI can render the candidate inline with a "merge into
    // this" button. inArray batched per [[feedback_d1_batch_param_limit]].
    const candidateIds = [
      ...new Set(
        eventsList
          .map((e) => e.possibleDuplicateOf)
          .filter((id): id is string => typeof id === "string" && id.length > 0)
      ),
    ];
    const candidateMap = new Map<
      string,
      { id: string; name: string; slug: string; status: string; startDate: Date | null }
    >();
    if (candidateIds.length > 0) {
      const BATCH_SIZE = 50;
      for (let i = 0; i < candidateIds.length; i += BATCH_SIZE) {
        const batch = candidateIds.slice(i, i + BATCH_SIZE);
        const rows = await db
          .select({
            id: events.id,
            name: events.name,
            slug: events.slug,
            status: events.status,
            startDate: events.startDate,
          })
          .from(events)
          .where(inArray(events.id, batch));
        for (const r of rows) {
          candidateMap.set(r.id, {
            id: r.id,
            name: r.name,
            slug: r.slug as string,
            status: r.status,
            startDate: r.startDate,
          });
        }
      }
    }

    const enriched = eventsList.map((e) => ({
      ...e,
      blogPostCount: byEvent.get(e.id) ?? 0,
      possibleDuplicate: e.possibleDuplicateOf
        ? (candidateMap.get(e.possibleDuplicateOf) ?? null)
        : null,
    }));

    return NextResponse.json(enriched);
  } catch (error) {
    await logError(db, {
      message: "Failed to fetch events",
      error,
      source: "api/admin/events",
      request,
    });
    return NextResponse.json({ error: "Failed to fetch events" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Validate request body
  const validation = await validateRequestBody(request, eventCreateSchema);
  if (!validation.success) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const data = validation.data;

  const db = getCloudflareDb();
  try {
    const eventId = crypto.randomUUID();
    const baseSlug = createSlug(data.name);

    // Handle empty slug (e.g., name with only special characters)
    if (!baseSlug) {
      return NextResponse.json(
        { error: "Event name must contain alphanumeric characters" },
        { status: 400 }
      );
    }

    // WS2a — shared helper (prefix-range query + findUniqueSlug). Was inlined.
    const slug = await resolveUniqueEventSlug(db, baseSlug);

    // Auto-compute startDate/endDate from eventDays when discontinuous.
    // A3 (Dev backlog 2026-06-05): route through normalizeEventDate so a
    // bare YYYY-MM-DD lands at noon UTC (canonical anchor) rather than
    // the midnight-UTC default that renders as previous-day-EDT.
    let startDate = normalizeEventDate(data.startDate);
    let endDate = normalizeEventDate(data.endDate);
    if (data.discontinuousDates && data.eventDays && data.eventDays.length > 0) {
      const sorted = data.eventDays.map((d) => d.date).sort();
      startDate = parseDateOnly(sorted[0]);
      endDate = parseDateOnly(sorted[sorted.length - 1]);
    }

    // Auto-compute public date range (excluding vendor-only days)
    const { publicStartDate, publicEndDate } =
      data.eventDays && data.eventDays.length > 0
        ? computePublicDates(data.eventDays)
        : { publicStartDate: startDate, publicEndDate: endDate };

    // Derive stateCode from the attached venue when not explicitly provided,
    // so state filters stay in sync without callers having to pass both.
    let resolvedStateCode = data.stateCode ?? null;
    if (!resolvedStateCode && data.venueId) {
      const venueRow = await db
        .select({ state: venues.state })
        .from(venues)
        .where(eq(venues.id, data.venueId))
        .limit(1);
      resolvedStateCode = venueRow[0]?.state ?? null;
    }

    const applicationDeadline = data.applicationDeadline
      ? new Date(data.applicationDeadline)
      : null;

    // Pre-ingest gate evaluation. Admin POST is typically Tier 1 (human-typed),
    // but admin can paste a Tier 3 source URL into the form — and Tier 1 still
    // runs the date-plausibility checks (start_equals_deadline, multi-day vs
    // single-day storage, etc.). Mirrors the call pattern in /admin/import-url
    // and /admin/import. Failures override the admin-chosen status to PENDING
    // and record reasons in gate_flags so the events_pending_review rule
    // surfaces the row for re-review.
    const gateResult = evaluateGates({
      name: data.name,
      sourceUrl: data.sourceUrl ?? null,
      sourceName: data.sourceName ?? null,
      startDate,
      endDate,
      applicationDeadline,
      description: data.description ?? null,
    });
    const finalStatus = gateResult.route === "PENDING_REVIEW" ? "PENDING" : data.status;
    const gateFlagsJson = gateResult.reasons.length > 0 ? JSON.stringify(gateResult.reasons) : null;
    const sourceClassification = classifySource(data.sourceName, data.sourceUrl);

    await db.insert(events).values({
      id: eventId,
      name: data.name,
      slug: unsafeSlug(slug),
      description: data.description,
      venueId: data.venueId,
      stateCode: resolvedStateCode,
      isStatewide: data.isStatewide ?? false,
      promoterId: data.promoterId,
      startDate,
      endDate,
      publicStartDate,
      publicEndDate,
      datesConfirmed: data.datesConfirmed,
      discontinuousDates: data.discontinuousDates || false,
      categories: JSON.stringify(data.categories),
      tags: JSON.stringify(data.tags),
      ticketUrl: data.ticketUrl,
      ticketPriceMinCents: dollarsToCents(data.ticketPriceMin),
      ticketPriceMaxCents: dollarsToCents(data.ticketPriceMax),
      imageUrl: data.imageUrl,
      featured: data.featured,
      commercialVendorsAllowed: data.commercialVendorsAllowed,
      status: finalStatus,
      gateFlags: gateFlagsJson,
      sourceName: data.sourceName,
      sourceDomain: sourceClassification.sourceDomain,
      // Admin POST is by definition admin_manual when no source signal exists.
      ingestionMethod: sourceClassification.ingestionMethod ?? "admin_manual",
      sourceUrl: data.sourceUrl,
      sourceId: data.sourceId,
      vendorFeeMinCents: dollarsToCents(data.vendorFeeMin),
      vendorFeeMaxCents: dollarsToCents(data.vendorFeeMax),
      vendorFeeNotes: data.vendorFeeNotes,
      indoorOutdoor: data.indoorOutdoor,
      estimatedAttendance: data.estimatedAttendance,
      eventScale: data.eventScale,
      applicationDeadline,
      applicationUrl: data.applicationUrl,
      applicationInstructions: data.applicationInstructions,
      walkInsAllowed: data.walkInsAllowed,
    });

    await recomputeEventCompleteness(db, eventId);

    // Insert event days if provided. D1 caps each statement at 100 bound
    // parameters; event_days rows pass 9 columns (8 explicit + the $defaultFn
    // createdAt), so chunks are capped at 11 rows (11 × 9 = 99). The previous
    // WS2a — shared D1-safe batched insert (was an inline BATCH_SIZE=11 loop).
    await insertEventDaysBatched(db, eventId, data.eventDays);

    const [newEvent] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);

    // IndexNow: ping if the admin created this event already publicly visible.
    if (newEvent && PUBLIC_EVENT_SET.has(newEvent.status)) {
      const env = getCloudflareEnv() as unknown as { INDEXNOW_KEY?: string };
      await pingIndexNow(db, indexNowUrlFor("events", newEvent.slug), env, "event-create");
    }

    return NextResponse.json(newEvent, { status: 201 });
  } catch (error) {
    await logError(db, {
      message: "Failed to create event",
      error,
      source: "api/admin/events",
      request,
    });
    const message = error instanceof Error ? error.message : "";
    if (message.includes("UNIQUE constraint failed") || message.includes("unique")) {
      return NextResponse.json(
        { error: "An event with this name already exists" },
        { status: 409 }
      );
    }
    if (message.includes("FOREIGN KEY constraint failed")) {
      return NextResponse.json({ error: "Invalid promoter or venue selected" }, { status: 400 });
    }
    return NextResponse.json({ error: "Failed to create event" }, { status: 500 });
  }
}
