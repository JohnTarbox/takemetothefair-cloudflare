export const dynamic = "force-dynamic";
/**
 * GET /api/admin/snap/nearby?lat=&lng=&date=YYYY-MM-DD — OPE-1341. Public events
 * running today near the phone, nearest first, for the snap page's event pin.
 * Omit lat AND lng for every public event running that day, alphabetical — the
 * location-free picker list (OPE-1549).
 * ADMIN-only. `date` is the phone's LOCAL date (the photo resolver's semantics).
 *
 * `?recent=1` — OPE-1705 slice 3, the "Met them at…" list: the events the
 * signed-in admin's own snaps matched in the last 30 days, most recent first.
 */
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api/with-auth";
import { findEventsOnDate, findNearbyEvents, findRecentSnapEvents } from "@/lib/snap/nearby";

export const GET = withAuth({ role: "ADMIN" }, async ({ request, db, session }) => {
  const p = new URL(request.url).searchParams;
  if (p.get("recent") === "1") {
    return NextResponse.json({
      events: await findRecentSnapEvents(db, session.user.email ?? ""),
    });
  }
  const date = p.get("date") ?? "";
  // OPE-1549 — no lat/lng at all is the location-free "Pick the fair" list:
  // every public event running on `date`, alphabetical. It must work with the
  // phone's location denied, so it never requires a fix.
  if (!p.has("lat") && !p.has("lng")) {
    return NextResponse.json({ events: await findEventsOnDate(db, date) });
  }
  const lat = Number(p.get("lat"));
  const lng = Number(p.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return NextResponse.json({ error: "lat and lng are required together" }, { status: 400 });
  }
  return NextResponse.json({
    events: await findNearbyEvents(db, { latitude: lat, longitude: lng }, date),
  });
});
