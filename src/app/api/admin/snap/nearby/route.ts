export const dynamic = "force-dynamic";
/**
 * GET /api/admin/snap/nearby?lat=&lng=&date=YYYY-MM-DD — OPE-1341. Public events
 * running today near the phone, nearest first, for the snap page's event pin.
 * ADMIN-only. `date` is the phone's LOCAL date (the photo resolver's semantics).
 */
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api/with-auth";
import { findNearbyEvents } from "@/lib/snap/nearby";

export const GET = withAuth({ role: "ADMIN" }, async ({ request, db }) => {
  const p = new URL(request.url).searchParams;
  const lat = Number(p.get("lat"));
  const lng = Number(p.get("lng"));
  const date = p.get("date") ?? "";
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return NextResponse.json({ error: "lat and lng are required" }, { status: 400 });
  }
  return NextResponse.json({
    events: await findNearbyEvents(db, { latitude: lat, longitude: lng }, date),
  });
});
