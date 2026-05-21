import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getCloudflareAi, getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { extractMultipleEvents } from "@/lib/url-import/ai-extractor";
import { tryExtractFromJsonLd } from "@/lib/url-import/jsonld-to-event";
import type { PageMetadata, ExtractedEvent } from "@/lib/url-import/types";
import { expandCadence } from "@/lib/url-import/cadence-expander";
import { logError } from "@/lib/logger";

export const runtime = "edge";

const extractRequestSchema = z.object({
  content: z.string().min(1, "Content is required"),
  url: z.string().url().optional(),
  metadata: z
    .object({
      title: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      ogImage: z.string().nullable().optional(),
      jsonLd: z.record(z.string(), z.unknown()).nullable().optional(),
    })
    .optional(),
});

export async function POST(request: NextRequest) {
  const db = getCloudflareDb();
  // Accept admin session OR X-Internal-Key (MCP Worker email handler).
  const internalKey = request.headers.get("x-internal-key");
  const cfEnv = getCloudflareEnv() as unknown as { INTERNAL_API_KEY?: string };
  const isInternal = !!(
    internalKey &&
    cfEnv.INTERNAL_API_KEY &&
    internalKey === cfEnv.INTERNAL_API_KEY
  );
  if (!isInternal) {
    const session = await auth();
    if (!session || session.user.role !== "ADMIN") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const body = await request.json();
    const validation = extractRequestSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { success: false, error: validation.error.issues[0]?.message || "Validation failed" },
        { status: 400 }
      );
    }

    const { content, metadata } = validation.data;

    // JSON-LD priority extraction: if the fetched page emitted a complete-
    // enough schema.org Event node, skip the AI call entirely and return
    // the JSON-LD-derived event. JSON-LD is authoritative on these pages
    // (WordPress events plugins, venue CMSes); the AI just paraphrases the
    // same content from prose, often with worse fidelity. Bypass kicks in
    // when the mapper returns non-null (name + startDate + at least one of
    // {location, description}); otherwise we fall through to AI.
    if (metadata?.jsonLd) {
      const jsonLdEvent = tryExtractFromJsonLd(metadata.jsonLd);
      if (jsonLdEvent) {
        const extractId = `jsonld-${Date.now()}-0`;
        const event: ExtractedEvent = { ...jsonLdEvent, _extractId: extractId };
        // Every populated field gets "high" confidence: schema.org Event is
        // the authoritative source on the page. Nulls get "low" — the
        // mapper already gates on name+startDate+one-of-{location,desc} so
        // most events have ≥3 high fields.
        const confidence: Record<string, "high" | "medium" | "low"> = {};
        for (const [key, value] of Object.entries(event)) {
          if (key.startsWith("_")) continue;
          confidence[key] = value === null || value === undefined ? "low" : "high";
        }
        return NextResponse.json({
          success: true,
          events: [event],
          confidence: { [extractId]: confidence },
          count: 1,
          extractionMethod: "json-ld",
        });
      }
    }

    const ai = getCloudflareAi();

    // Call AI extraction for multiple events
    const { events, confidence } = await extractMultipleEvents(
      ai,
      content,
      (metadata || {}) as PageMetadata
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
}
