import { NextResponse } from "next/server";
import { getCloudflareDb } from "@/lib/cloudflare";
import { eventVendors, events } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { authenticateVendorToken } from "@/lib/api-token-auth";
import { isValidTransition } from "@/lib/vendor-status";
import { logError } from "@/lib/logger";

export const runtime = "edge";

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const db = getCloudflareDb();
  try {
    const { slug } = await params;

    // Authenticate via Bearer token
    const auth = await authenticateVendorToken(request, slug);
    if (!auth.authorized) {
      return NextResponse.json({ error: auth.error }, { status: 401 });
    }

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
      .where(eq(eventVendors.vendorId, auth.vendorId));

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
  } catch (error) {
    await logError(db, {
      message: "Error fetching vendor applications",
      error,
      source: "api/vendors/[slug]/applications",
      request,
    });
    return NextResponse.json({ error: "Failed to fetch applications" }, { status: 500 });
  }
}

/** PATCH — update vendor's own application status/paymentStatus for an event */
export async function PATCH(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const db = getCloudflareDb();
  try {
    const { slug } = await params;

    const auth = await authenticateVendorToken(request, slug);
    if (!auth.authorized) {
      return NextResponse.json({ error: auth.error }, { status: 401 });
    }

    let body: { eventId?: string; status?: string; paymentStatus?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    if (!body.eventId) {
      return NextResponse.json({ error: "eventId is required" }, { status: 400 });
    }

    // Find existing application or create one
    const [existing] = await db
      .select()
      .from(eventVendors)
      .where(and(eq(eventVendors.vendorId, auth.vendorId), eq(eventVendors.eventId, body.eventId)))
      .limit(1);

    if (!existing) {
      // Create new vendor-event record
      const newStatus = (body.status ?? "CONFIRMED") as typeof eventVendors.$inferInsert.status;
      const newPayment = (body.paymentStatus ??
        "NOT_REQUIRED") as typeof eventVendors.$inferInsert.paymentStatus;

      await db.insert(eventVendors).values({
        eventId: body.eventId,
        vendorId: auth.vendorId,
        status: newStatus,
        paymentStatus: newPayment,
      });

      return NextResponse.json(
        {
          eventId: body.eventId,
          status: newStatus,
          paymentStatus: newPayment,
          created: true,
        },
        { status: 201 }
      );
    }

    const updates: Record<string, string> = {};

    // Validate status transition if provided
    if (body.status && body.status !== existing.status) {
      if (!isValidTransition(existing.status, body.status)) {
        return NextResponse.json(
          { error: `Cannot transition from ${existing.status} to ${body.status}` },
          { status: 400 }
        );
      }
      updates.status = body.status;
    }

    if (body.paymentStatus) {
      updates.paymentStatus = body.paymentStatus;
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ message: "No changes" });
    }

    await db.update(eventVendors).set(updates).where(eq(eventVendors.id, existing.id));

    return NextResponse.json({
      eventId: body.eventId,
      status: updates.status ?? existing.status,
      paymentStatus: updates.paymentStatus ?? existing.paymentStatus,
    });
  } catch (error) {
    await logError(db, {
      message: "Error updating vendor application",
      error,
      source: "api/vendors/[slug]/applications",
      request,
    });
    return NextResponse.json({ error: "Failed to update application" }, { status: 500 });
  }
}
