import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { findDuplicate } from "@/lib/duplicates/find-duplicate";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { logError } from "@/lib/logger";

export const runtime = "edge";

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
