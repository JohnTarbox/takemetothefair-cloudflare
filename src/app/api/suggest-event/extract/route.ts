import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCloudflareAi, getCloudflareDb } from "@/lib/cloudflare";
import { extractEventData } from "@/lib/url-import/ai-extractor";
import { logError } from "@/lib/logger";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

export const runtime = "edge";

const extractRequestSchema = z.object({
  content: z.string().min(1, "Content is required"),
  url: z.string().url().optional(),
  metadata: z.object({
    title: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    ogImage: z.string().nullable().optional(),
    jsonLd: z.record(z.string(), z.unknown()).nullable().optional(),
  }).optional(),
});

export async function POST(request: NextRequest) {
  // Rate limiting check
  const rateLimitResult = await checkRateLimit(request, "suggest-event-extract");
  if (!rateLimitResult.allowed) {
    return rateLimitResponse(rateLimitResult);
  }

  const db = getCloudflareDb();

  try {
    const body = await request.json();
    const validation = extractRequestSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { success: false, error: validation.error.issues[0]?.message || "Validation failed" },
        { status: 400 }
      );
    }

    const { content, url, metadata } = validation.data;

    const ai = getCloudflareAi();

    console.log("[Suggest Extract] Starting AI extraction, content length:", content.length);

    // Call AI extraction for single event (simplified for suggestions)
    const { extracted, confidence } = await extractEventData(
      ai,
      content,
      metadata || {}
    );

    console.log("[Suggest Extract] AI extracted event:", extracted.name);

    // If URL provided but no ticketUrl extracted, use source URL
    if (url && !extracted.ticketUrl) {
      extracted.ticketUrl = url;
    }

    return NextResponse.json({
      success: true,
      extracted,
      confidence,
    });
  } catch (error) {
    await logError(db, { message: "Extraction error", error, source: "api/suggest-event/extract", request });
    return NextResponse.json(
      {
        success: false,
        extracted: null,
        confidence: {},
        error: "Could not extract event data. Please fill in the details manually.",
      },
      { status: 200 }
    );
  }
}
