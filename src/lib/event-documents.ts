/**
 * OPE-1580 — read side of posted vendor forms. Writes live in the MCP Worker
 * (`mcp-server/src/event-documents.ts`); this is what the public page and the
 * download route ask.
 */
import { and, eq, gt } from "drizzle-orm";
import type { getCloudflareDb } from "@/lib/cloudflare";
import { eventDocuments } from "@/lib/db/schema";

type Db = ReturnType<typeof getCloudflareDb>;

export async function getLiveEventDocuments(db: Db, eventId: string, now: Date = new Date()) {
  return db
    .select({
      id: eventDocuments.id,
      displayName: eventDocuments.displayName,
      mimeType: eventDocuments.mimeType,
      sizeBytes: eventDocuments.sizeBytes,
      kind: eventDocuments.kind,
      sourceOrganizer: eventDocuments.sourceOrganizer,
      receivedAt: eventDocuments.receivedAt,
    })
    .from(eventDocuments)
    .where(
      and(
        eq(eventDocuments.eventId, eventId),
        eq(eventDocuments.status, "live"),
        gt(eventDocuments.expiresAt, now)
      )
    )
    .orderBy(eventDocuments.postedAt);
}
