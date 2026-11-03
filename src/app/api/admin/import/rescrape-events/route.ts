export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events } from "@/lib/db/schema";
import { isAuthorized } from "@/lib/api-auth";
import { logError } from "@/lib/logger";
import { getDetailsScraper } from "@/lib/scrapers/registry";
import { sanitizeScrapedDescription } from "@/lib/scrapers/utils";
import { inArray, eq } from "drizzle-orm";
import { loadClassifications, gateUrlForField } from "@/lib/url-classification";
import { recomputeEventCompleteness } from "@/lib/completeness";
import { logEnrichment } from "@/lib/enrichment-log";
import { loadOperatorLockedFields } from "@/lib/scrapers/operator-edited-fields";

export async function POST(request: Request) {
  const db = getCloudflareDb();

  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await request.json()) as { event_ids?: string[] };
    const eventIds = body.event_ids;

    if (!eventIds || !Array.isArray(eventIds) || eventIds.length === 0) {
      return NextResponse.json(
        { error: "event_ids must be a non-empty array of event IDs" },
        { status: 400 }
      );
    }

    if (eventIds.length > 50) {
      return NextResponse.json({ error: "Maximum 50 events per request" }, { status: 400 });
    }

    // Fetch the requested events
    const targetEvents = await db
      .select({
        id: events.id,
        name: events.name,
        description: events.description,
        sourceName: events.sourceName,
        sourceUrl: events.sourceUrl,
        startDate: events.startDate,
        endDate: events.endDate,
        imageUrl: events.imageUrl,
        ticketUrl: events.ticketUrl,
      })
      .from(events)
      .where(inArray(events.id, eventIds));

    const results = {
      requested: eventIds.length,
      found: targetEvents.length,
      updated: 0,
      skipped: 0,
      /** OPE-1410 — total field writes withheld because an operator edited them. */
      operatorEditedFieldsSkipped: 0,
      errors: [] as string[],
      details: [] as {
        id: string;
        name: string;
        status: "updated" | "skipped" | "no_source" | "no_scraper" | "error";
        fieldsUpdated?: string[];
        /** OPE-1410 — fields the scrape would have changed but an operator owns. */
        fieldsSkippedOperatorEdited?: string[];
        error?: string;
      }[],
    };

    // Load classifications once for the whole batch — used to gate any
    // detail-scraped website URL before assigning it to ticket_url.
    const urlClassifications = await loadClassifications(db);

    // OPE-1410 — fields an operator edited after the scraper last wrote them.
    // The rescrape never overwrites those; it reports them instead.
    const operatorLocked = await loadOperatorLockedFields(
      db,
      targetEvents.map((e) => e.id)
    );

    for (const event of targetEvents) {
      // Skip events without source info
      if (!event.sourceName || !event.sourceUrl) {
        results.skipped++;
        results.details.push({
          id: event.id,
          name: event.name,
          status: "no_source",
        });
        continue;
      }

      // Look up the detail scraper
      const detailsScraper = getDetailsScraper(event.sourceName);
      if (!detailsScraper) {
        results.skipped++;
        results.details.push({
          id: event.id,
          name: event.name,
          status: "no_scraper",
        });
        continue;
      }

      try {
        const details = await detailsScraper(event.sourceUrl);

        // Build updates for all changed fields (same as sync)
        const updates: Record<string, unknown> = {};
        const fieldsUpdated: string[] = [];
        const locked = operatorLocked.get(event.id);
        const fieldsSkippedOperatorEdited: string[] = [];
        // Every write below goes through here: an operator-edited field is
        // reported, not overwritten.
        const setField = (
          field: "description" | "startDate" | "endDate" | "imageUrl" | "ticketUrl",
          value: unknown
        ) => {
          if (locked?.has(field)) {
            fieldsSkippedOperatorEdited.push(field);
            return;
          }
          updates[field] = value;
          fieldsUpdated.push(field);
        };

        // K22 — sanitize at the persistence boundary (decode entities + strip
        // the "… Read more »" truncation tail) so re-scrapes can't refill the
        // bucket with encoded/truncated previews.
        const cleanDescription = sanitizeScrapedDescription(details.description);
        if (cleanDescription && cleanDescription !== event.description) {
          setField("description", cleanDescription);
        }
        if (
          details.startDate &&
          (!event.startDate || details.startDate.getTime() !== new Date(event.startDate).getTime())
        ) {
          setField("startDate", details.startDate);
        }
        if (
          details.endDate &&
          (!event.endDate || details.endDate.getTime() !== new Date(event.endDate).getTime())
        ) {
          setField("endDate", details.endDate);
        }
        if (details.imageUrl && details.imageUrl !== event.imageUrl) {
          setField("imageUrl", details.imageUrl);
        }
        if (details.website && details.website !== event.ticketUrl) {
          // Gate detail-scraped URL against classification — otherwise rescrape
          // re-introduces aggregator URLs to events that were manually cleaned.
          const gatedWebsite = gateUrlForField(details.website, "ticket", urlClassifications);
          if (gatedWebsite !== event.ticketUrl) {
            setField("ticketUrl", gatedWebsite);
          }
        }

        results.operatorEditedFieldsSkipped += fieldsSkippedOperatorEdited.length;
        const skippedReport =
          fieldsSkippedOperatorEdited.length > 0 ? { fieldsSkippedOperatorEdited } : {};

        if (fieldsUpdated.length > 0) {
          updates.lastSyncedAt = new Date();
          updates.updatedAt = new Date();
          await db.update(events).set(updates).where(eq(events.id, event.id));
          await recomputeEventCompleteness(db, event.id);
          await logEnrichment(db, {
            targetType: "event",
            targetId: event.id,
            source: "scraper",
            status: "success",
            fieldsChanged: fieldsUpdated,
            notes: "rescrape-events sweep",
          });
          results.updated++;
          results.details.push({
            id: event.id,
            name: event.name,
            status: "updated",
            fieldsUpdated,
            ...skippedReport,
          });
        } else {
          // Update sync timestamp even if nothing changed
          await db.update(events).set({ lastSyncedAt: new Date() }).where(eq(events.id, event.id));
          results.skipped++;
          results.details.push({
            id: event.id,
            name: event.name,
            status: "skipped",
            ...skippedReport,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";

        // OPE-424 — record the failure DURABLY.
        //
        // Until now an unreachable source produced only a string in
        // `results.errors`, returned in the HTTP response and then gone. The
        // success and no-change branches both write (lastSyncedAt, and success
        // additionally writes enrichment_log), so afterwards there was no way
        // to tell "the organizer's site is unreachable" from "we re-synced and
        // nothing had changed". That is the FAM-EXTERNAL-DEFERRAL shape from
        // OPE-243: *unreachable* and *nothing changed* indistinguishable from
        // the outside — and it is how ~12 organizer-own sites could go
        // permanently unfetchable while their aggregator-derived data sat on
        // the page looking confident.
        //
        // enrichment_log already models this (source + status='failure'), so
        // the durable surface exists; the error path simply never used it.
        // Best-effort: a logging failure must not abort the remaining events
        // in the sweep.
        try {
          await logEnrichment(db, {
            targetType: "event",
            targetId: event.id,
            source: "scraper",
            status: "failure",
            notes: `rescrape-events sweep — source unreachable or unparseable: ${message}`.slice(
              0,
              500
            ),
          });
        } catch {
          /* best-effort — never lose the rest of the sweep over a log write */
        }

        results.errors.push(`${event.name}: ${message}`);
        results.details.push({
          id: event.id,
          name: event.name,
          status: "error",
          error: message,
        });
      }
    }

    // Report any requested IDs that weren't found
    const foundIds = new Set(targetEvents.map((e) => e.id));
    for (const id of eventIds) {
      if (!foundIds.has(id)) {
        results.details.push({
          id,
          name: "Unknown",
          status: "error",
          error: "Event not found",
        });
        results.errors.push(`Event ID ${id}: not found`);
      }
    }

    return NextResponse.json(results);
  } catch (error) {
    await logError(db, {
      message: "Error re-scraping events",
      error,
      source: "api/admin/import/rescrape-events",
      request,
    });
    return NextResponse.json({ error: "Failed to re-scrape events" }, { status: 500 });
  }
}
