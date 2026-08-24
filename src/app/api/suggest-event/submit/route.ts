export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { events, promoters, eventSchemaOrg } from "@/lib/db/schema";
import { parseJsonLd } from "@/lib/schema-org";
import { eq } from "drizzle-orm";
import {
  createSlug,
  computePublicDates,
  dollarsToCents,
  unsafeSlug,
  formatDateRange,
} from "@/lib/utils";
import { resolveUniqueEventSlug, insertEventDaysBatched } from "@/lib/events/insert-helpers";
import { attachEventToSeries } from "@/lib/series/resolve-or-create-series";
import { logError } from "@/lib/logger";
import { recomputeEventCompleteness } from "@/lib/completeness";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { evaluateGates } from "@/lib/event-date-gates";
import { verifyTurnstileToken, getTurnstileErrorMessage } from "@/lib/turnstile";
import { auth } from "@/lib/auth";
import { inferCategoriesFromName } from "@/lib/url-import/infer-categories";
import { loadClassifications, gateUrlForField } from "@/lib/url-classification";
import { PUBLIC_EVENT_STATUSES } from "@/lib/constants";
import { classifySource, assertIngestionMethod } from "@/lib/source-classification";
import { pingIndexNow, indexNowUrlFor } from "@/lib/indexnow";
import { autoLinkVenue, deriveStateFromText } from "@/lib/venue-matching";
import { normalizeEventDate } from "@/lib/event-dates";
import { singleDayWithHours } from "@/lib/single-day-hours";
import { groundNameInSources } from "@/lib/url-import/name-grounding";
import { qualifyNameWithHost } from "@/lib/url-import/host-qualified-name";
import {
  areDatesContiguous,
  isUnusableEventName,
  isLikelyImageUrl,
  isPlaceholderUrl,
} from "@takemetothefair/utils";
import { maybeRouteToOccurrence } from "@/lib/discovery/route-to-occurrence";
import { submitEventSchema } from "./schema";
import { sendSubmissionReceivedAck } from "@/lib/email/submission-received";

const PUBLIC_EVENT_SET = new Set<string>(PUBLIC_EVENT_STATUSES);

// The stable ID for the Community Suggestions promoter
// OPE-458 — COMMUNITY_PROMOTER_ID now lives beside the resolver that falls
// back to it, so the placeholder and the rules that avoid it stay together.
import {
  COMMUNITY_PROMOTER_ID,
  resolvePromoterForSource,
} from "@/lib/promoters/resolve-from-source";

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

    // OPE-411 — a name that cannot be an event name must never become a slug.
    //
    // A 2026-08-04 submission arrived with name="Facebook" (the platform the
    // submitter found it on) and minted `/event/facebook`. It was caught only
    // because it happened to sit in PENDING where a human looked.
    //
    // Two different answers, because there are two different callers:
    //
    //   - An interactive submitter is AT THE FORM and can fix it in five
    //     seconds. Telling them beats accepting junk and quietly holding it,
    //     and it is the only branch that can actually improve the data.
    //   - An internal caller (the MCP email pipeline) has nobody at a keyboard.
    //     Rejecting there would DROP a real submission because one field was
    //     wrong, so it is held for review instead — with the submitted string
    //     preserved in the description, since the point is that a human can see
    //     what was actually sent.
    const nameIsUnusable = isUnusableEventName(data.name);
    if (nameIsUnusable && !isInternal) {
      return NextResponse.json(
        {
          success: false,
          error:
            'Please enter the event\'s own name (for example "Northeast Egg & Art Expo 2026") — not the website or app where you found it.',
        },
        { status: 400 }
      );
    }

    // Held internal submissions get a placeholder that reads as unfinished to
    // anyone who sees it, rather than a confident wrong name.
    const baseName = nameIsUnusable
      ? `Untitled submission${data.venueCity ? ` — ${data.venueCity}` : ""}${
          data.startDate ? ` (${data.startDate})` : ""
        }`
      : data.name;

    // OPE-378 defect 4 — the organizer never reached the name.
    //
    // The Waterville specimen produced "28th Annual Craft Fair": true, and
    // useless. It names no fair in particular, collides with every other craft
    // fair in the state, and the source said who ran it in its first clause.
    //
    // Applied to MACHINE submissions only. On the internal path a name is
    // something an extractor assembled and this is a naming convention; on the
    // public form it is what a person typed, and silently rewriting that is a
    // different act with a different failure mode. `qualifyNameWithHost` is a
    // deterministic rule, not a model call — deliberately, since name synthesis
    // is exactly what produced the invented "Holiday" in defect 2 of this same
    // ticket. It only ever PREPENDS a host drawn from the submission, so the
    // grounding gate below still passes by construction.
    const hostQualified =
      isInternal && !nameIsUnusable
        ? qualifyNameWithHost(baseName, data.venueName)
        : { name: baseName, applied: false as const };
    const effectiveName = hostQualified.name;

    // Generate event slug. WS2a — shared prefix-range resolver (was a
    // per-candidate while-loop; now `base-2` first on collision, not `base-1`).
    const eventSlug = createSlug(effectiveName);
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

    // Build description. The `Location:` block is appended LATER, and only if
    // the venue fails to resolve — see the venue auto-link below.
    let description = data.description || `${effectiveName} - suggested by the community`;
    if (nameIsUnusable) {
      // Preserve exactly what was submitted. The reviewer's first question is
      // "what did they actually send?", and an unusable name is often the only
      // clue to where the event came from.
      description += `\n\nSubmitted event name: "${data.name.trim()}" — held for review (not a usable event name).`;
    }
    const locationParts: string[] = [];
    if (data.venueName || data.venueCity) {
      if (data.venueName) locationParts.push(data.venueName);
      if (data.venueAddress) locationParts.push(data.venueAddress);
      if (data.venueCity) locationParts.push(data.venueCity);
      if (data.venueState) locationParts.push(data.venueState);
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
      name: effectiveName,
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

    // OPE-411 — an unusable name is never publishable, whatever the source.
    // Vendor submissions would otherwise land TENTATIVE (publicly visible).
    if (nameIsUnusable) {
      gateRoute = "PENDING_REVIEW";
      if (!gateReasons.includes("unusable_name")) gateReasons.push("unusable_name");
    }

    // NOTE: `eventStatus` / `gateFlagsJson` are derived AFTER effectiveStartDate
    // is known (see the OPE-458 re-check below), because a discontinuous
    // submission's real start date is not settled at this point.
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

    // OPE-411 — three field-level sanity checks the domain classifier does not
    // make. It answers "is this an aggregator?"; these answer "is this value
    // even the KIND of thing this column holds?"
    //
    // 1. image_url must be an image. `https://crafters-choice-llc.square.site/`
    //    reached the column and renders as a broken <img> on the card and in the
    //    OG tag.
    // 2. A non-image URL is not thrown away — if it is the only ticket-ish URL
    //    we have, it is far more likely to be the organizer's ticketing page
    //    (which is exactly what that Square URL was) than an image.
    // 3. Placeholder URLs (`example.com/buy-tickets` is live in prod today) are
    //    dropped rather than stored as a link a real visitor will click.
    const submittedImageUrl = data.imageUrl?.trim() || null;
    const sanitizedImageUrl = isLikelyImageUrl(submittedImageUrl) ? submittedImageUrl : null;
    const nonImageAsTicketUrl =
      submittedImageUrl && !sanitizedImageUrl && !isPlaceholderUrl(submittedImageUrl)
        ? submittedImageUrl
        : null;
    const finalTicketUrl =
      gatedTicketUrl && !isPlaceholderUrl(gatedTicketUrl)
        ? gatedTicketUrl
        : (nonImageAsTicketUrl ?? null);
    const finalApplicationUrl =
      gatedApplicationUrl && !isPlaceholderUrl(gatedApplicationUrl) ? gatedApplicationUrl : null;

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
    // OPE-411 — append the `Location:` block ONLY when the venue did not
    // resolve.
    //
    // This block was never the submitter's prose: the route writes it so the
    // address is not lost when `autoLinkVenue` conservatively declines to match.
    // That is worth doing — but it ran unconditionally and BEFORE the match was
    // attempted, so 29 of 52 community/email rows carry a location paragraph
    // that is already on their linked venue record. Duplicated into the public
    // description, the meta description, and the search index.
    //
    // Now it is what it was meant to be: a fallback for the unresolved case,
    // where it is the only surviving record of where the event is and an
    // operator needs to read it.
    if (locationParts.length > 0 && !resolvedVenueId && !description.includes(locationParts[0])) {
      description += `\n\nLocation: ${locationParts.join(", ")}`;
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
    // OPE-531 — a one-day event's hours, which previously had nowhere to go.
    const singleDayHoursDate = singleDayWithHours({
      startDate,
      endDate,
      hasExplicitDays: Boolean(
        (data.eventDays && data.eventDays.length > 0) ||
        (data.specificDates && data.specificDates.length > 0)
      ),
      startTime: data.startTime,
      endTime: data.endTime,
    });

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
          : // OPE-531 — a single-day event's hours had nowhere to go.
            //
            // `data.startTime` / `data.endTime` were read ONLY inside the
            // `specificDates` branch above, and `events` has no time columns:
            // hours live exclusively in `event_days`. So a one-day submission
            // carrying "10 AM-3 PM" — the overwhelmingly common shape for a
            // craft fair or makers market — had its hours silently discarded
            // at this line, after being extracted correctly.
            //
            // Live specimen: the VCS Makers Market body states "10 AM-3 PM"
            // twice; the stored event has no `event_days` row at all.
            //
            // Only fires when there is genuinely nothing else: no explicit
            // eventDays, no specificDates, a real start date, at least one
            // known time, and a single calendar day. Multi-day events are
            // left alone — spreading one time range across a range of dates
            // would assert per-day hours nobody stated, which is the OPE-465
            // fabrication direction.
            singleDayHoursDate
            ? [
                {
                  date: singleDayHoursDate,
                  openTime: data.startTime || null,
                  closeTime: data.endTime || null,
                },
              ]
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

    // OPE-458 — re-run the past-date gate against the date we are ABOUT TO
    // STORE, not the one we were handed.
    //
    // The guard ~180 lines up runs on `startDate`. For a discontinuous
    // submission the stored start date is recomputed from `event_days` right
    // above, so a submission whose dates arrive only as `specificDates` was
    // gated on a null (or unrelated) value and then persisted with a past one.
    //
    // Live specimen: `3fbf9829` "Vineyard Artisans Festivals", start 2024-06-15,
    // four event_days spanning 2024-06-15 → 2024-12-08, `gate_flags = NULL`.
    // Its two siblings from the same email had no event_days, took the ordinary
    // path, and were gated correctly — which is exactly why this was invisible:
    // the gate demonstrably works, on the rows that reach it.
    //
    // Idempotent: `past_date` is only appended when absent, so a row already
    // gated above is unchanged.
    if (effectiveStartDate && effectiveStartDate.getTime() < Date.now()) {
      gateRoute = "PENDING_REVIEW";
      if (!gateReasons.includes("past_date")) gateReasons.push("past_date");
    }

    // OPE-378 — a name token that appears in no source is a fabrication.
    //
    // One submission produced "28th Annual Holiday Craft Fair" from a body that
    // never says "Holiday". Every other word was genuinely there; one added
    // token, plausible for a November craft fair, changed what the event is.
    //
    // Flagged rather than rewritten: a name is human-facing, and deleting a
    // word from it can produce something worse than the embellishment. This
    // routes it to the review queue that already exists. Grounding is checked
    // against EVERY text we saw (description carries the submitted prose), so a
    // name legitimately drawn from a flyer is not accused.
    const nameGrounding = groundNameInSources(effectiveName, [
      description ?? null,
      data.name ?? null,
      data.sourceUrl ?? null,
    ]);
    if (nameGrounding.shouldFlag && !gateReasons.includes("ungrounded_name")) {
      gateReasons.push("ungrounded_name");
      gateRoute = "PENDING_REVIEW";
    }

    // OPE-378 — record that the convention fired, WITHOUT touching gateRoute.
    // A qualified name is more correct than the one we were given, so routing it
    // to review would punish the fix. The flag exists so the rewrite is
    // queryable: if the convention ever starts firing on names it should not,
    // `gate_flags LIKE '%host_qualified_name%'` is how anyone would find out.
    if (hostQualified.applied) gateReasons.push("host_qualified_name");

    const eventStatus = gateRoute === "PENDING_REVIEW" ? "PENDING" : baseEventStatus;
    const gateFlagsJson = gateReasons.length > 0 ? JSON.stringify(gateReasons) : null;

    // K34 / EH3 P3.3b — if this submission is really a new EDITION of an
    // existing event that belongs to a SERIES (different year), attach it as an
    // occurrence under that series instead of minting a year-suffixed standalone
    // (the cheshire-fair-nh-2027 class). INERT until the P1 backfill sets
    // series_id: until then any findDuplicate hit has no series, so this returns
    // routed:false and we fall through to the standalone insert below unchanged.
    const occRoute = await maybeRouteToOccurrence(db, {
      name: effectiveName,
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
          event: { id: r.occurrenceId, slug: r.slug, name: effectiveName },
          year: r.year,
        });
      }
      if (r.reason === "occurrence_exists") {
        // The edition already exists under the series — don't create a sibling.
        return NextResponse.json({
          success: true,
          routed: "occurrence_exists",
          event: { id: r.existingEventId, name: effectiveName },
          year: r.year,
        });
      }
      // series_not_found / promoter_required: fall through to the standalone
      // insert (safe default — better a standalone row than a dropped submission).
    }

    // OPE-458 scope 3 — resolve the owning promoter instead of defaulting every
    // submission to the community placeholder.
    //
    // Four events named "Vineyard Artisans …" were created from
    // vineyardartisans.com while a promoter of exactly that name already owned
    // two of its other festivals. OPE-201 normalizes the VENUE on auto-created
    // events; nothing ever did the same for the promoter.
    //
    // Fails closed: an ambiguous or absent match keeps COMMUNITY_PROMOTER_ID.
    // A wrong owner is invisibly incorrect (it publishes on someone else's
    // page); the placeholder is merely visibly incomplete.
    let resolvedPromoterId: string = COMMUNITY_PROMOTER_ID;
    try {
      const owner = await resolvePromoterForSource(db, {
        sourceUrl: data.sourceUrl ?? null,
        eventName: effectiveName,
      });
      if (owner) resolvedPromoterId = owner.promoterId;
    } catch {
      // Never fail a submission over ownership enrichment — the placeholder is
      // a correct, reviewable answer.
    }

    // Create the event
    const newEventId = crypto.randomUUID();
    await db.insert(events).values({
      id: newEventId,
      name: effectiveName,
      slug: finalEventSlug,
      description,
      promoterId: resolvedPromoterId,
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
      // OPE-411 — a start date being PRESENT is not the same as a date being
      // CONFIRMED, and this line conflated them: 45 of the 52 community/email
      // rows in prod claim confirmed dates and nothing confirmed any of them.
      // `dates_confirmed` drives "these dates are verified" downstream, so a
      // user submission must start at false and be raised by an operator or a
      // verified source. A vendor submission is already TENTATIVE-lifecycle for
      // exactly this reason.
      datesConfirmed: false,
      categories: JSON.stringify(
        Array.isArray(data.categories) && data.categories.length > 0
          ? data.categories
          : (inferCategoriesFromName(effectiveName) ?? ["Event"])
      ),
      tags: JSON.stringify(tagList),
      ticketUrl: finalTicketUrl,
      ticketPriceMinCents: dollarsToCents(data.ticketPriceMin),
      ticketPriceMaxCents: dollarsToCents(data.ticketPriceMax),
      // OPE-411 — only a URL that is actually an image. The case that produced
      // this ticket stored `https://crafters-choice-llc.square.site/` (the
      // organizer's ticketing site) in image_url, which renders as a broken
      // <img> on the card and the OG tag. A non-image URL is dropped here and
      // preserved as ticket_url below when nothing better is present.
      imageUrl: sanitizedImageUrl,
      status: eventStatus,
      gateFlags: gateFlagsJson,
      lifecycleStatus: eventLifecycle,
      sourceName,
      // Three suggest_event variants (vendor / email / community) map to
      // three distinct ingestion methods via the classifier's label table.
      // sourceDomain comes from data.sourceUrl when the submitter included one.
      sourceDomain: classifySource(sourceName, data.sourceUrl).sourceDomain,
      // OPE-491 — assert the derived method before it reaches the INSERT. The
      // column is plain TEXT with no CHECK and no Drizzle enum, so this is the
      // only enforcement point. (The `?? "community_suggestion"` fallback that
      // used to sit here was unreachable: classifySource never returns
      // null/undefined — it defaults to admin_manual by contract.)
      ingestionMethod: assertIngestionMethod(
        classifySource(sourceName, data.sourceUrl).ingestionMethod,
        "suggest-event/submit"
      ),
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
      applicationUrl: finalApplicationUrl,
      // OPE-198 — vendor-application deadline (date-only) + apply instructions.
      applicationDeadline: normalizeEventDate(data.applicationDeadline ?? null),
      applicationInstructions: data.applicationInstructions ?? null,
      walkInsAllowed: data.walkInsAllowed ?? null,
      // Cohort 2 (2026-06-01) — populated when the inbound-email workflow
      // detected a MEDIUM-confidence dedup hit. NULL on every other path.
      possibleDuplicateOf: data.possibleDuplicateOf ?? null,
      // DQ4: flag for review when any event_day row carries NULL hours.
      // OPE-201: also flag a past-dated auto-create — it's likely a real past
      // EDITION that needs web-confirmation → OCCURRED in the review/analyst
      // lane (the headless worker can't web-confirm), not an upcoming event.
      // Operator triage queue at /admin/events?flagged=1.
      flaggedForReview:
        anyHoursUnknown ||
        gateReasons.includes("past_date") ||
        // OPE-378 — an invented name reads perfectly, so it needs a human.
        gateReasons.includes("ungrounded_name")
          ? 1
          : 0,
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

    // OPE-472 — attach to a series parent at write time.
    //
    // This is the highest-volume unparented path: `event_series` has minted
    // nothing since 2026-06-30, and 170 of the 172 events created since
    // 2026-07-01 were born with `series_id` NULL. Attaching here is what stops
    // that number growing; the existing backlog is a separate (backfill)
    // question and is not touched.
    //
    // After the insert, not inside it: the event is already durable, and the
    // parent is an enhancement. A series failure must never cost a submission.
    await attachEventToSeries(db, newEventId, {
      name: effectiveName,
      venueId: resolvedVenueId,
      promoterId: resolvedPromoterId,
      description,
    });

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

    // OPE-412 — the receipt the submitter never got.
    //
    // Runs AFTER the event is safely written and never throws: a submission
    // must succeed even when its acknowledgment cannot be sent. Losing an email
    // is a small harm; losing the event somebody typed in is the failure this
    // whole path exists to prevent.
    //
    // The outcome is LOGGED rather than dropped, because "we chose not to send"
    // (gate off, suppressed, rate-limited) and "we tried and failed" are
    // different facts, and a fail-soft path that records neither is how a
    // silent no-op survives for months.
    const ackOutcome = await sendSubmissionReceivedAck(
      db,
      getCloudflareEnv() as unknown as {
        EMAIL_JOBS?: Queue<unknown>;
        SUBMISSION_ACK_ENABLED?: string;
      },
      {
        toEmail: data.suggesterEmail,
        eventName: effectiveName,
        eventId: newEventId,
        whenText: effectiveStartDate ? formatDateRange(effectiveStartDate, effectiveEndDate) : null,
        whereText:
          [data.venueName, data.venueCity, resolvedStateCode].filter(Boolean).join(", ") || null,
      }
    );
    if (ackOutcome !== "sent" && ackOutcome !== "skipped:no-email") {
      await logError(db, {
        level: "info",
        message: `submission-received ack not sent: ${ackOutcome}`,
        source: "suggest-event-submit",
        context: { eventId: newEventId, outcome: ackOutcome },
      });
    }

    return NextResponse.json({
      success: true,
      event: {
        id: newEventId,
        slug: finalEventSlug,
        name: effectiveName,
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
