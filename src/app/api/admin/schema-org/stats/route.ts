export const dynamic = "force-dynamic";
/**
 * Schema.org sync coverage stats.
 *
 * Moved here from `/api/admin/schema-org/sync` GET when the old chunked
 * POST endpoint was retired in favour of the SchemaOrgSyncWorkflow.
 * The admin UI button reads this for the coverage / missing-count display.
 */

import { NextResponse } from "next/server";
import { eq, isNotNull, sql } from "drizzle-orm";
import { withAuth } from "@/lib/api/with-auth";
import { events, eventSchemaOrg } from "@/lib/db/schema";
import { logError } from "@/lib/logger";

export const GET = withAuth({ role: "ADMIN" }, async ({ request, db }) => {
  try {
    const [eventsWithTicketUrl] = await db
      .select({ count: sql<number>`count(*)` })
      .from(events)
      .where(isNotNull(events.ticketUrl));

    const [eventsWithSchemaOrg] = await db
      .select({ count: sql<number>`count(*)` })
      .from(eventSchemaOrg)
      .where(eq(eventSchemaOrg.status, "available"));

    const statusCounts = await db
      .select({
        status: eventSchemaOrg.status,
        count: sql<number>`count(*)`,
      })
      .from(eventSchemaOrg)
      .groupBy(eventSchemaOrg.status);

    const statusMap: Record<string, number> = {};
    for (const row of statusCounts) {
      statusMap[row.status] = row.count;
    }

    return NextResponse.json({
      eventsWithTicketUrl: eventsWithTicketUrl?.count || 0,
      eventsWithSchemaOrg: eventsWithSchemaOrg?.count || 0,
      statusBreakdown: statusMap,
    });
  } catch (error) {
    await logError(db, {
      message: "Failed to get schema.org stats",
      error,
      source: "api/admin/schema-org/stats",
      request,
    });
    return NextResponse.json({ error: "Failed to get schema.org stats" }, { status: 500 });
  }
});
