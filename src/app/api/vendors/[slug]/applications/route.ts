export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { withApiToken } from "@/lib/api/with-auth";
import { eventVendors, events } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { applyVendorTokenPatch, type TokenPatchBody } from "@/lib/vendor-applications";

export const GET = withApiToken<{ slug: string }>(
  { source: "api/vendors/[slug]/applications" },
  async ({ db, vendorId }) => {
    // Get all applications for this vendor
    const results = await db
      .select({
        eventId: eventVendors.eventId,
        status: eventVendors.status,
        paymentStatus: eventVendors.paymentStatus,
        boothInfo: eventVendors.boothInfo,
        createdAt: eventVendors.createdAt,
        eventName: events.name,
        eventSlug: events.slug,
        eventStartDate: events.startDate,
        eventEndDate: events.endDate,
      })
      .from(eventVendors)
      .innerJoin(events, eq(eventVendors.eventId, events.id))
      .where(eq(eventVendors.vendorId, vendorId));

    return NextResponse.json({
      applications: results.map((r) => ({
        eventId: r.eventId,
        eventSlug: r.eventSlug,
        eventName: r.eventName,
        eventStartDate: r.eventStartDate,
        eventEndDate: r.eventEndDate,
        status: r.status,
        paymentStatus: r.paymentStatus,
        boothInfo: r.boothInfo,
        createdAt: r.createdAt,
      })),
    });
  }
);

/**
 * PATCH — create or update the vendor's own application for an event.
 *
 * OPE-1361: the rules live in `applyVendorTokenPatch` (shared with the session
 * route's checks) — APPLIED by default, CONFIRMED/APPROVED only for a
 * canSelfConfirm vendor, APPROVED events only, commercial rule, verified email,
 * paymentStatus held to its enum.
 */
export const PATCH = withApiToken<{ slug: string }>(
  { source: "api/vendors/[slug]/applications" },
  async ({ request, db, vendorId }) => {
    let body: TokenPatchBody;
    try {
      body = (await request.json()) as TokenPatchBody;
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const result = await applyVendorTokenPatch(db, vendorId, body);
    if (!result.ok) {
      return NextResponse.json(
        result.message ? { error: result.error, message: result.message } : { error: result.error },
        { status: result.httpStatus }
      );
    }
    return NextResponse.json(result.body, { status: result.httpStatus });
  }
);
