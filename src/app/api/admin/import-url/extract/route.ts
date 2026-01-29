import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareAi, getCloudflareDb } from "@/lib/cloudflare";
import { extractMultipleEvents } from "@/lib/url-import/ai-extractor";
import type { PageMetadata } from "@/lib/url-import/types";
import { logError } from "@/lib/logger";

export const runtime = "edge";

export async function POST(request: NextRequest) {
  const db = getCloudflareDb();
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { content, url, metadata } = body as {
      content?: string;
      url?: string;
      metadata?: PageMetadata;
    };

    if (!content || content.trim().length === 0) {
      return NextResponse.json(
        { success: false, error: "Content is required" },
        { status: 400 }
      );
    }

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
