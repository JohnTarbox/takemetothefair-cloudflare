import { NextResponse } from "next/server";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events } from "@/lib/db/schema";
import { auth } from "@/lib/auth";
import { logError } from "@/lib/logger";
import { getDetailsScraper } from "@/lib/scrapers/registry";
import { like, and, isNotNull } from "drizzle-orm";
import { eq } from "drizzle-orm";

export async function POST(request: Request) {
  const db = getCloudflareDb();
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dryRun") === "true";

  try {
    // Find events with truncated descriptions (ending with "...")
    const truncatedEvents = await db
      .select({
        id: events.id,
        name: events.name,
        description: events.description,
        sourceName: events.sourceName,
        sourceUrl: events.sourceUrl,
      })
      .from(events)
      .where(
        and(
          like(events.description, "%..."),
          isNotNull(events.sourceName),
          isNotNull(events.sourceUrl)
        )
      );

    const results = {
      found: truncatedEvents.length,
      updated: 0,
      skipped: 0,
      noScraper: 0,
      errors: [] as string[],
      previews: [] as { name: string; sourceName: string; status: string }[],
    };

    if (dryRun) {
      // Preview mode: just report what would be re-scraped
      for (const event of truncatedEvents) {
        const scraper = getDetailsScraper(event.sourceName);
        results.previews.push({
          name: event.name,
          sourceName: event.sourceName!,
          status: scraper ? "will re-scrape" : "no scraper available",
        });
        if (!scraper) results.noScraper++;
      }
      return NextResponse.json(results);
    }

    // Actual re-scrape
    for (const event of truncatedEvents) {
      try {
        const detailsScraper = getDetailsScraper(event.sourceName);
        if (!detailsScraper) {
          results.noScraper++;
          results.skipped++;
          continue;
        }

        const details = await detailsScraper(event.sourceUrl!);

        if (
          details.description &&
          details.description !== event.description &&
          !details.description.endsWith("...")
        ) {
          await db
            .update(events)
            .set({
              description: details.description,
              updatedAt: new Date(),
            })
            .where(eq(events.id, event.id));
          results.updated++;
        } else {
          results.skipped++;
        }
      } catch (error) {
        results.errors.push(
          `${event.name}: ${error instanceof Error ? error.message : "Unknown error"}`
        );
      }
    }

    return NextResponse.json(results);
  } catch (error) {
    await logError(db, {
      message: "Error re-scraping descriptions",
      error,
      source: "api/admin/import/rescrape-descriptions",
      request,
    });
    return NextResponse.json({ error: "Failed to re-scrape descriptions" }, { status: 500 });
  }
}
