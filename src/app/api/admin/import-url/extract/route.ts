export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuthorized } from "@/lib/api/with-auth";
import { getCloudflareAi } from "@/lib/cloudflare";
import { extractMultipleEvents } from "@/lib/url-import/ai-extractor";
import { tryExtractFromJsonLd } from "@/lib/url-import/jsonld-to-event";
import type { PageMetadata, ExtractedEvent } from "@/lib/url-import/types";
import { expandCadence } from "@/lib/url-import/cadence-expander";
import { composeDeterministicExtract } from "@/lib/url-import/deterministic/compose";
import { logError } from "@/lib/logger";

const extractRequestSchema = z.object({
  content: z.string().min(1, "Content is required"),
  url: z.string().url().optional(),
  metadata: z
    .object({
      title: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      ogImage: z.string().nullable().optional(),
      jsonLd: z.record(z.string(), z.unknown()).nullable().optional(),
      jsonLdEvents: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
    })
    .optional(),
  // Analyst D1 (2026-05-29 PM). Optional email body for two-section
  // prompt structure when an email submission carries both a URL and
  // body prose with dates. The AI extractor prefers body dates over
  // the linked page's when both are present; the linked page is often
  // a vendor-application form whose displayed date is a stale season
  // template ("Every other Saturday beginning 4/11/2026"). Capped at
  // 8KB before reaching the prompt — same budget as content.
  emailBody: z.string().max(8000).optional(),
});

// Accept admin session OR X-Internal-Key (MCP Worker email handler), via
// withAuthorized — constant-time, replacing a prior timing-unsafe `===`.
export const POST = withAuthorized(async ({ request, db }) => {
  try {
    const body = await request.json();
    const validation = extractRequestSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { success: false, error: validation.error.issues[0]?.message || "Validation failed" },
        { status: 400 }
      );
    }

    const { content, url, metadata, emailBody } = validation.data;

    // JSON-LD priority extraction: if the fetched page emitted complete-
    // enough schema.org Event node(s), skip the AI call entirely and return
    // the JSON-LD-derived events. JSON-LD is authoritative on these pages
    // (WordPress events plugins, venue CMSes); the AI just paraphrases the
    // same content from prose, often with worse fidelity.
    //
    // Multi-event support (analyst 2026-05-22 P7a): when `jsonLdEvents`
    // carries N>1 Event-schema nodes, map each through the same gate. A
    // venue calendar emitting one Event per upcoming show used to drop
    // all but the first; now every qualifying node becomes a candidate
    // for selection in the admin UI. Falls back to the legacy single-
    // node `jsonLd` field when `jsonLdEvents` isn't populated (older
    // fetch responses).
    const jsonLdNodes: Record<string, unknown>[] =
      metadata?.jsonLdEvents && metadata.jsonLdEvents.length > 0
        ? metadata.jsonLdEvents
        : metadata?.jsonLd
          ? [metadata.jsonLd]
          : [];

    if (jsonLdNodes.length > 0) {
      const now = Date.now();
      const eventsFromJsonLd: ExtractedEvent[] = [];
      const confidenceMap: Record<string, Record<string, "high" | "medium" | "low">> = {};
      for (let i = 0; i < jsonLdNodes.length; i++) {
        const jsonLdEvent = tryExtractFromJsonLd(jsonLdNodes[i]);
        if (!jsonLdEvent) continue;
        const extractId = `jsonld-${now}-${i}`;
        const event: ExtractedEvent = { ...jsonLdEvent, _extractId: extractId };
        eventsFromJsonLd.push(event);
        // Every populated field gets "high" confidence: schema.org Event is
        // the authoritative source on the page. Nulls get "low" — the
        // mapper already gates on name+startDate+one-of-{location,desc} so
        // most events have ≥3 high fields.
        const confidence: Record<string, "high" | "medium" | "low"> = {};
        for (const [key, value] of Object.entries(event)) {
          if (key.startsWith("_")) continue;
          confidence[key] = value === null || value === undefined ? "low" : "high";
        }
        confidenceMap[extractId] = confidence;
      }
      if (eventsFromJsonLd.length > 0) {
        return NextResponse.json({
          success: true,
          events: eventsFromJsonLd,
          confidence: confidenceMap,
          count: eventsFromJsonLd.length,
          extractionMethod: "json-ld",
        });
      }
    }

    const ai = getCloudflareAi();

    // Call AI extraction for multiple events. Pass emailBody as a fourth
    // arg (analyst D1, 2026-05-29 PM); when non-empty the extractor
    // structures the prompt with two labeled sections — email body
    // marked PRIMARY for dates, fetched URL content secondary.
    const { events, confidence } = await extractMultipleEvents(
      ai,
      content,
      (metadata || {}) as PageMetadata,
      emailBody
    );

    // Removed pre-2026-05-22 ticketUrl defaulting block. Defaulting the
    // ticket field to the source URL silently copied page URLs (and
    // sometimes vendor-application form URLs) into the ticket field,
    // breaking trust. Both extraction branches (AI and JSON-LD) now leave
    // ticket_url NULL when no genuine ticketing/registration link is
    // found — the field is supposed to mean "where to buy tickets", not
    // "where the event lives". See ai-extractor.ts:393 + jsonld-to-event.ts:66.

    // Cadence backstop: when the AI returned a wide date range with empty
    // specificDates AND the description mentions a cadence phrase, expand
    // deterministically into per-occurrence dates. Catches the
    // LLM-doesn't-enumerate failure mode (582f3156 biweekly market —
    // AI returned a 7-month span and empty specificDates instead of 16
    // Saturdays). Skipped when the AI already produced a specificDates
    // list or when the date span is short.
    for (const event of events) {
      if (event.specificDates && event.specificDates.length > 0) continue;
      if (!event.startDate || !event.endDate) continue;
      if (!event.description) continue;
      const startMs = Date.parse(event.startDate);
      const endMs = Date.parse(event.endDate);
      if (!isFinite(startMs) || !isFinite(endMs)) continue;
      // Only expand for ranges > 14 days. A normal multi-day event
      // (county fair Aug 2-10) has a contiguous schedule, not a cadence.
      if (endMs - startMs < 14 * 86400000) continue;
      const expanded = expandCadence(event.description, {
        windowStart: event.startDate.slice(0, 10),
        windowEnd: event.endDate.slice(0, 10),
      });
      if (expanded.length >= 2) {
        event.specificDates = expanded;
      }
    }

    // K7 Tier 1 (analyst, 2026-05-31) — deterministic salvage path. When
    // the AI returned zero events but the page has structured calendar
    // links OR a clear month-day-range heading + name, synthesize a single
    // thin extraction so the workflow flags the inbound row for human
    // review instead of hard-failing. Surfaced by inbound fe65fb77 (moose
    // lottery): scrapeable Elementor page, no JSON-LD, AI silent. The
    // page's <h1>+<h2> would have given us name + June 19-20 range with
    // zero AI cost. See src/lib/url-import/deterministic/compose.ts for
    // the gate (name + (date OR venue)).
    //
    // Returns extractionMethod='thin' so the mark-done step on the MCP
    // server can set inbound_emails.flagged_for_review=1 + the reply uses
    // the LOW-confidence "queued for review" template (driven by sparse
    // field confidence from the composer).
    if (events.length === 0) {
      // `content` is already cleaned text on the URL-fetch path (fetch
      // route calls extractTextFromHtml before sending). That means the
      // calendar-link sub-extractor won't find <a href> tags here — it
      // still runs in case the caller (e.g. body-text submissions) passes
      // raw HTML verbatim. For the moose-lottery canonical case we rely
      // on metadata.title + findDateRange over the cleaned text, which
      // suffices for "name + date" gate satisfaction. Deferred to Tier 2:
      // thread raw HTML through SubmitFetchResult so the calendar-link
      // path can fire on URL-fetched pages too.
      const salvaged = composeDeterministicExtract(
        content,
        content,
        metadata as PageMetadata | undefined,
        url
      );
      if (salvaged.events.length > 0) {
        return NextResponse.json({
          success: true,
          events: salvaged.events,
          confidence: salvaged.confidence,
          count: salvaged.events.length,
          extractionMethod: "thin",
        });
      }
    }

    return NextResponse.json({
      success: true,
      events,
      confidence,
      count: events.length,
      extractionMethod: "ai",
    });
  } catch (error) {
    await logError(db, {
      message: "Extraction error",
      error,
      source: "api/admin/import-url/extract",
      request,
    });
    return NextResponse.json(
      {
        success: false,
        events: [],
        confidence: {},
        error: "Could not extract event data. Please add events manually.",
      },
      { status: 200 }
    );
  }
});
