export const dynamic = "force-dynamic";
/**
 * OPE-212 §5 — list an event's gallery for the admin manager.
 *
 * ADMIN ONLY, and that is the whole authorization story. Unlike vendors,
 * events have no owner and no self-service path — John's greenlight is
 * explicit: "NOT approved: public write path (there isn't one for events; if
 * you're considering vendor-style self-service on events, that's a separate
 * gate)."
 *
 * So this deliberately does NOT reuse `authorizeVendorGallery`. That function
 * encodes "admin OR the row's owner", and an event has no owner — reusing it
 * would mean inventing an ownership concept for events purely to satisfy a
 * shared signature, which is how a gate gets widened by accident.
 */
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api/with-auth";
import { events } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { getEventGallery } from "@/lib/event-photos";

export const GET = withAuth({ role: "ADMIN" }, async ({ request, db }) => {
  const eventId = new URL(request.url).searchParams.get("eventId");
  if (!eventId) return NextResponse.json({ error: "eventId is required" }, { status: 400 });

  const [row] = await db
    .select({ name: events.name })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  if (!row) return NextResponse.json({ error: "Event not found" }, { status: 404 });

  const photos = await getEventGallery(db, eventId, row.name);
  return NextResponse.json({ photos: photos.map((p) => ({ ...p, isLegacy: false })) });
});
