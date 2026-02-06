import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getCloudflareAi, getCloudflareDb } from "@/lib/cloudflare";
import { extractMultipleEvents } from "@/lib/url-import/ai-extractor";
import { logError } from "@/lib/logger";

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
  const db = getCloudflareDb();
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

    const { content, url, metadata } = validation.data;

    const ai = getCloudflareAi();

    console.log("[Extract] Starting multi-event AI extraction, content length:", content.length);
    console.log("[Extract] Metadata:", JSON.stringify(metadata || {}, null, 2).substring(0, 500));

    // Call AI extraction for multiple events
    const { events, confidence } = await extractMultipleEvents(
      ai,
      content,
      metadata || {}
    );

    console.log("[Extract] AI extracted", events.length, "events");

    // If URL provided but no ticketUrl extracted, use source URL for events without one
    if (url) {
      for (const event of events) {
        if (!event.ticketUrl) {
          event.ticketUrl = url;
        }
      }
    }

    return NextResponse.json({
      success: true,
      events,
      confidence,
      count: events.length,
    });
  } catch (error) {
    await logError(db, { message: "Extraction error", error, source: "api/admin/import-url/extract", request });
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
