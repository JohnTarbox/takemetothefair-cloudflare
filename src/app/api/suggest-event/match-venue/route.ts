import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq, and, or, like } from "drizzle-orm";
import { getCloudflareDb } from "@/lib/cloudflare";
import { venues } from "@/lib/db/schema";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

export const runtime = "edge";

const matchVenueSchema = z.object({
  venueName: z.string().min(1),
  venueCity: z.string().nullable().optional(),
  venueState: z.string().nullable().optional(),
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
  const rateLimitResult = await checkRateLimit(request, "suggest-event-match-venue");
  if (!rateLimitResult.allowed) {
    return rateLimitResponse(rateLimitResult);
  }

  try {
    const body = await request.json();
    const validation = matchVenueSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { success: false, error: validation.error.issues[0]?.message || "Validation failed" },
        { status: 400 }
      );
    }

    const { venueName, venueCity, venueState } = validation.data;
    const db = getCloudflareDb();
    const normalizedInput = normalizeName(venueName);

    // First try exact match on name (case insensitive via normalization)
    // Then try fuzzy matching

    // Get potential matches - venues in the same state or with similar names
    let potentialMatches;
    if (venueState) {
      potentialMatches = await db
        .select({
          id: venues.id,
          name: venues.name,
          slug: venues.slug,
          city: venues.city,
          state: venues.state,
          address: venues.address,
        })
        .from(venues)
        .where(
          or(
            eq(venues.state, venueState.toUpperCase()),
            like(venues.name, `%${venueName.split(" ")[0]}%`)
          )
        )
        .limit(50);
    } else {
      // Without state, search by name similarity only
      potentialMatches = await db
        .select({
          id: venues.id,
          name: venues.name,
          slug: venues.slug,
          city: venues.city,
          state: venues.state,
          address: venues.address,
        })
        .from(venues)
        .where(like(venues.name, `%${venueName.split(" ")[0]}%`))
        .limit(50);
    }

    // Score and rank matches
    const scoredMatches = potentialMatches
      .map((venue) => {
        const normalizedVenueName = normalizeName(venue.name);
        let score = similarity(normalizedInput, normalizedVenueName);

        // Boost score if city matches
        if (venueCity && venue.city) {
          const cityMatch = similarity(
            normalizeName(venueCity),
            normalizeName(venue.city)
          );
          if (cityMatch > 0.8) {
            score += 0.15;
          }
        }

        // Boost score if state matches
        if (venueState && venue.state) {
          if (venue.state.toUpperCase() === venueState.toUpperCase()) {
            score += 0.1;
          }
        }

        // Cap score at 1.0 (100%)
        return { ...venue, score: Math.min(score, 1.0) };
      })
      .filter((v) => v.score > 0.6) // Only keep reasonably good matches
      .sort((a, b) => b.score - a.score)
      .slice(0, 5); // Return top 5 matches

    if (scoredMatches.length === 0) {
      return NextResponse.json({
        success: true,
        matchFound: false,
        matches: [],
      });
    }

    // Return the best match and alternatives
    const bestMatch = scoredMatches[0];
    const alternatives = scoredMatches.slice(1);

    return NextResponse.json({
      success: true,
      matchFound: true,
      bestMatch: {
        id: bestMatch.id,
        name: bestMatch.name,
        slug: bestMatch.slug,
        city: bestMatch.city,
        state: bestMatch.state,
        address: bestMatch.address,
        confidence: Math.round(bestMatch.score * 100),
      },
      alternatives: alternatives.map((v) => ({
        id: v.id,
        name: v.name,
        slug: v.slug,
        city: v.city,
        state: v.state,
        confidence: Math.round(v.score * 100),
      })),
    });
  } catch (error) {
    console.error("[Match Venue] Error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to match venue" },
      { status: 500 }
    );
  }
}
