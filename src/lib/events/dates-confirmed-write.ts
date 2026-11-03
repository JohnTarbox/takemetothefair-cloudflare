/**
 * OPE-1200 — the main app's side of the dates_confirmed citation gate.
 *
 * Loads the event's active start_date citations and runs the shared rule in
 * `@takemetothefair/utils` (`gateDatesConfirmed`), which the MCP Worker's
 * `update_event` also uses. For an insert pass `eventId: null`: a new row has no
 * citations, so a requested TRUE is written as FALSE unless the caller supplies
 * a qualifying source in the same call.
 */
import { and, eq } from "drizzle-orm";
import {
  gateDatesConfirmed,
  organizerHostsFrom,
  type CallDateSource,
  type DatesConfirmedGateResult,
} from "@takemetothefair/utils";
import { eventDataCitations, events, promoters } from "@/lib/db/schema";
import type { getCloudflareDb } from "@/lib/cloudflare";

type Db = ReturnType<typeof getCloudflareDb>;

export async function gateDatesConfirmedWrite(
  db: Db,
  args: { eventId: string | null; requested: boolean; callSource?: CallDateSource | null }
): Promise<DatesConfirmedGateResult> {
  if (!args.requested) return { value: false, downgraded: false };
  const citations = args.eventId
    ? await db
        .select({
          fieldName: eventDataCitations.fieldName,
          state: eventDataCitations.state,
          sourceType: eventDataCitations.sourceType,
          sourceUrl: eventDataCitations.sourceUrl,
        })
        .from(eventDataCitations)
        .where(
          and(
            eq(eventDataCitations.eventId, args.eventId),
            eq(eventDataCitations.fieldName, "start_date"),
            eq(eventDataCitations.state, "active")
          )
        )
    : [];
  // OPE-1231 — the event's own promoter's site counts as the organizer even
  // when its host is on the aggregator list (Visit Freeport → visitfreeport.com).
  const promoterSite = args.eventId
    ? await db
        .select({ website: promoters.website })
        .from(events)
        .innerJoin(promoters, eq(promoters.id, events.promoterId))
        .where(eq(events.id, args.eventId))
        .limit(1)
    : [];
  return gateDatesConfirmed({
    requested: true,
    citations,
    callSource: args.callSource ?? null,
    organizerHosts: organizerHostsFrom(promoterSite.map((p) => p.website)),
  });
}
