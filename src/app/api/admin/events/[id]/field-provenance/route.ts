export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { withAuth } from "@/lib/api/with-auth";
import { eventDataCitations, eventFieldPins } from "@/lib/db/schema";

/**
 * GET /api/admin/events/[id]/field-provenance — OPE-1613.
 *
 * The active citation per field (where its current value came from, and the
 * authority rung it records) plus every live pin. `provenance: "unclassified"`
 * is a citation written before drizzle/0406 — reported as such, never inferred
 * from `source_type`. Read-only; the MCP twin is `get_event_field_provenance`.
 */
export const GET = withAuth<{ id: string }>({ role: "ADMIN" }, async ({ db, params }) => {
  const cites = await db
    .select({
      field: eventDataCitations.fieldName,
      value: eventDataCitations.value,
      provenanceKind: eventDataCitations.provenanceKind,
      sourceType: eventDataCitations.sourceType,
      sourceName: eventDataCitations.sourceName,
      sourceUrl: eventDataCitations.sourceUrl,
      createdAt: eventDataCitations.createdAt,
    })
    .from(eventDataCitations)
    .where(and(eq(eventDataCitations.eventId, params.id), eq(eventDataCitations.state, "active")))
    .orderBy(desc(eventDataCitations.createdAt));
  const pins = await db
    .select({
      field: eventFieldPins.fieldName,
      pinnedValue: eventFieldPins.pinnedValue,
      feedValueAtPin: eventFieldPins.feedValueAtPin,
      createdAt: eventFieldPins.createdAt,
    })
    .from(eventFieldPins)
    .where(and(eq(eventFieldPins.eventId, params.id), eq(eventFieldPins.status, "active")));
  const seen = new Set<string>();
  const fields = cites
    .filter((c) => (seen.has(c.field) ? false : (seen.add(c.field), true)))
    .map((c) => ({
      field: c.field,
      value: c.value,
      provenance: c.provenanceKind ?? "unclassified",
      sourceType: c.sourceType,
      sourceName: c.sourceName,
      sourceUrl: c.sourceUrl,
      citedAt: c.createdAt?.toISOString() ?? null,
    }));
  return NextResponse.json({
    eventId: params.id,
    fields,
    pins: pins.map((p) => ({ ...p, createdAt: p.createdAt?.toISOString() ?? null })),
  });
});
