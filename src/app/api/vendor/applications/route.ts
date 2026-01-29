import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { vendors, events, eventVendors } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { logError } from "@/lib/logger";

export const runtime = "edge";


export async function GET(request: NextRequest) {
  const db = getCloudflareDb();
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {

    // Get the vendor for this user
    const vendorResults = await db
      .select()
      .from(vendors)
      .where(eq(vendors.userId, session.user.id))
      .limit(1);

    if (vendorResults.length === 0) {
      return NextResponse.json({ error: "Vendor profile not found" }, { status: 404 });
    }

    const vendor = vendorResults[0];

    // Get all applications for this vendor
    const applications = await db
      .select()
      .from(eventVendors)
      .where(eq(eventVendors.vendorId, vendor.id));

    return NextResponse.json(applications);
  } catch (error) {
    await logError(db, { message: "Failed to fetch applications", error, source: "api/vendor/applications", request });
    return NextResponse.json({ error: "Failed to fetch applications" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const db = getCloudflareDb();
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json() as Record<string, unknown>;
    const { eventId, boothInfo } = body;

    if (!eventId) {
      return NextResponse.json({ error: "Event ID is required" }, { status: 400 });
    }

    // Get the vendor for this user
    const vendorResults = await db
      .select()
      .from(vendors)
      .where(eq(vendors.userId, session.user.id))
      .limit(1);

    if (vendorResults.length === 0) {
      return NextResponse.json({ error: "Vendor profile not found. Please create a vendor profile first." }, { status: 404 });
    }

    const vendor = vendorResults[0];

    // Get the event
    const eventResults = await db
      .select()
      .from(events)
      .where(eq(events.id, eventId as string))
      .limit(1);

    if (eventResults.length === 0) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const event = eventResults[0];

    // Check if event is approved and accepting vendors
    if (event.status !== "APPROVED") {
      return NextResponse.json({ error: "This event is not currently accepting vendor applications" }, { status: 400 });
    }

    // COMMERCIAL VENDOR VALIDATION
    // If the vendor is commercial and the event doesn't allow commercial vendors, reject
    if (vendor.commercial && !event.commercialVendorsAllowed) {
      return NextResponse.json({
        error: "This event does not allow commercial vendors. Only non-commercial vendors may apply."
      }, { status: 403 });
    }

    // Check if vendor has already applied to this event
    const existingApplication = await db
      .select()
      .from(eventVendors)
      .where(and(
        eq(eventVendors.eventId, eventId as string),
        eq(eventVendors.vendorId, vendor.id)
      ))
      .limit(1);

    if (existingApplication.length > 0) {
      return NextResponse.json({ error: "You have already applied to this event" }, { status: 400 });
    }

    // Create the application
    const applicationId = crypto.randomUUID();
    await db.insert(eventVendors).values({
      id: applicationId,
      eventId: eventId as string,
      vendorId: vendor.id,
      boothInfo: boothInfo as string | undefined,
      status: "PENDING",
    });

    const newApplication = await db
      .select()
      .from(eventVendors)
      .where(eq(eventVendors.id, applicationId))
      .limit(1);

    return NextResponse.json(newApplication[0], { status: 201 });
  } catch (error) {
    await logError(db, { message: "Failed to submit application", error, source: "api/vendor/applications", request });
    return NextResponse.json({ error: "Failed to submit application" }, { status: 500 });
  }
}
