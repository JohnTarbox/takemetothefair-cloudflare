import { NextResponse } from "next/server";
import { getCloudflareDb } from "@/lib/cloudflare";
import { eventVendors, events } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { authenticateVendorToken } from "@/lib/api-token-auth";
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
