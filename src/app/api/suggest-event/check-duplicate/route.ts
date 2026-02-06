import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq, and, gte, lte } from "drizzle-orm";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events } from "@/lib/db/schema";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

export const runtime = "edge";

const checkDuplicateSchema = z.object({
  sourceUrl: z.string().url().optional(),
  name: z.string().optional(),
  startDate: z.string().optional(), // YYYY-MM-DD format
});

// Normalize a name for comparison
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Calculate string similarity using Levenshtein distance ratio
function similarity(s1: string, s2: string): number {
  const longer = s1.length > s2.length ? s1 : s2;
  const shorter = s1.length > s2.length ? s2 : s1;

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
  // Rate limiting check
  const rateLimitResult = await checkRateLimit(request, "suggest-event-check-duplicate");
  if (!rateLimitResult.allowed) {
    return rateLimitResponse(rateLimitResult);
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

    const { sourceUrl, name, startDate } = validation.data;
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
          },
        });
      }
    }

    // 2. Check name + date similarity
    if (name && startDate) {
      const normalizedName = normalizeName(name);
      const eventDate = new Date(startDate);

      // Query events within +/- 7 days
      const dateRange = 7 * 24 * 60 * 60 * 1000; // 7 days in ms
      const minDate = new Date(eventDate.getTime() - dateRange);
      const maxDate = new Date(eventDate.getTime() + dateRange);

      const similarEvents = await db
        .select({
          id: events.id,
          slug: events.slug,
          name: events.name,
          startDate: events.startDate,
          status: events.status,
        })
        .from(events)
        .where(
          and(
            gte(events.startDate, minDate),
            lte(events.startDate, maxDate)
          )
        );

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
    console.error("[Check Duplicate] Error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to check for duplicates" },
      { status: 500 }
    );
  }
}
