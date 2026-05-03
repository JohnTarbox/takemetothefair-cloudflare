/**
 * One-shot backfill of contaminated ticket_url / application_url values.
 *
 * Background: Before the URL classification gate (commit 808fe60), the
 * ingestion pipeline copied source aggregator URLs into events.ticket_url for
 * ~33% of populated rows. The analyst manually cleaned the top 30 by traffic.
 * This endpoint cleans up the rest by running every existing event through
 * the same `gateUrlForField` the live ingestion gate uses, so the backfill
 * and the ongoing prevention cannot drift.
 *
 * Defaults to dry-run. Pass `{ "apply": true }` in the body to actually
 * UPDATE rows. Idempotent — re-running after apply finds nothing to update.
 */

import { NextRequest, NextResponse } from "next/server";
import { eq, isNotNull, or } from "drizzle-orm";
import { requireAdminAuth } from "@/lib/api-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events } from "@/lib/db/schema";
import { loadClassifications, gateUrlForField, extractDomain } from "@/lib/url-classification";
import { logError } from "@/lib/logger";

export const runtime = "edge";

interface AffectedRow {
  id: string;
  slug: string;
  name: string;
  before: { ticketUrl: string | null; applicationUrl: string | null };
  after: { ticketUrl: string | null; applicationUrl: string | null };
  reason: string;
}

export async function POST(request: NextRequest) {
  const fail = await requireAdminAuth(request);
  if (fail) return fail;

  const db = getCloudflareDb();
  try {
    const body = (await request.json().catch(() => ({}))) as { apply?: boolean };
    const apply = body.apply === true;

    const classifications = await loadClassifications(db);

    // Only scan rows that actually have one of the URL fields populated —
    // skipping the NULL/NULL rows is most of the table.
    const candidates = await db
      .select({
        id: events.id,
        slug: events.slug,
        name: events.name,
        ticketUrl: events.ticketUrl,
        applicationUrl: events.applicationUrl,
      })
      .from(events)
      .where(or(isNotNull(events.ticketUrl), isNotNull(events.applicationUrl)));

    const affected: AffectedRow[] = [];

    for (const row of candidates) {
      const newTicket = gateUrlForField(row.ticketUrl, "ticket", classifications);
      const newApplication = gateUrlForField(row.applicationUrl, "application", classifications);
      const ticketChanged = (row.ticketUrl ?? null) !== (newTicket ?? null);
      const applicationChanged = (row.applicationUrl ?? null) !== (newApplication ?? null);
      if (!ticketChanged && !applicationChanged) continue;

      const reasonParts: string[] = [];
      if (ticketChanged) {
        const domain = extractDomain(row.ticketUrl);
        reasonParts.push(`ticketUrl ${domain ?? "<unparseable>"} → ${newTicket ? "kept" : "NULL"}`);
      }
      if (applicationChanged) {
        const domain = extractDomain(row.applicationUrl);
        reasonParts.push(
          `applicationUrl ${domain ?? "<unparseable>"} → ${newApplication ? "kept" : "NULL"}`
        );
      }

      affected.push({
        id: row.id,
        slug: row.slug,
        name: row.name,
        before: { ticketUrl: row.ticketUrl, applicationUrl: row.applicationUrl },
        after: { ticketUrl: newTicket, applicationUrl: newApplication },
        reason: reasonParts.join("; "),
      });
    }

    let updated = 0;
    if (apply && affected.length > 0) {
      // Update rows one at a time. D1 doesn't support transactions across
      // multiple UPDATE statements at the worker boundary, but each row
      // update is atomic on its own — partial-failure leaves a sane state.
      for (const row of affected) {
        await db
          .update(events)
          .set({
            ticketUrl: row.after.ticketUrl,
            applicationUrl: row.after.applicationUrl,
            updatedAt: new Date(),
          })
          .where(eq(events.id, row.id));
        updated++;
      }
    }

    return NextResponse.json({
      mode: apply ? "apply" : "dry-run",
      scanned: candidates.length,
      wouldUpdate: affected.length,
      updated,
      // Cap the returned list so the response stays manageable. Full count is
      // in `wouldUpdate`; if the number is wildly wrong, that's the signal.
      sample: affected.slice(0, 100),
    });
  } catch (error) {
    await logError(db, {
      message: "Failed to run url-classification backfill",
      error,
      source: "api/admin/url-classifications/backfill",
      request,
    });
    return NextResponse.json({ error: "Backfill failed" }, { status: 500 });
  }
}
