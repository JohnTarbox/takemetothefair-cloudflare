import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { eventVendors, vendors } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

export const runtime = "edge";


interface Params {
  params: Promise<{ id: string }>;
}

// GET - List vendors for an event
export async function GET(request: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const db = getCloudflareDb();

    const eventVendorResults = await db
      .select()
      .from(eventVendors)
      .leftJoin(vendors, eq(eventVendors.vendorId, vendors.id))
      .where(eq(eventVendors.eventId, id));

    const vendorList = eventVendorResults
      .filter((ev) => ev.vendors !== null)
      .map((ev) => ({
        ...ev.event_vendors,
        vendor: ev.vendors,
      }));

    return NextResponse.json(vendorList);
  } catch (error) {
    console.error("Failed to fetch event vendors:", error);
    return NextResponse.json({ error: "Failed to fetch vendors" }, { status: 500 });
  }
}

// POST - Add a vendor to an event
export async function POST(request: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const body = await request.json() as Record<string, unknown>;
    const { vendorId, status, boothInfo } = body;

    if (!vendorId) {
      return NextResponse.json({ error: "Vendor ID is required" }, { status: 400 });
    }

    const db = getCloudflareDb();

    // Check if vendor is already added to this event
    const existing = await db
      .select()
      .from(eventVendors)
      .where(and(
        eq(eventVendors.eventId, id),
        eq(eventVendors.vendorId, vendorId as string)
      ))
      .limit(1);

    if (existing.length > 0) {
      return NextResponse.json({ error: "Vendor is already added to this event" }, { status: 400 });
    }

    const eventVendorId = crypto.randomUUID();
    await db.insert(eventVendors).values({
      id: eventVendorId,
      eventId: id,
      vendorId: vendorId as string,
      status: (status as "PENDING" | "APPROVED" | "REJECTED") || "APPROVED",
      boothInfo: boothInfo as string | undefined,
    });

    const newEventVendor = await db
      .select()
      .from(eventVendors)
      .leftJoin(vendors, eq(eventVendors.vendorId, vendors.id))
      .where(eq(eventVendors.id, eventVendorId))
      .limit(1);

    return NextResponse.json({
      ...newEventVendor[0].event_vendors,
      vendor: newEventVendor[0].vendors,
    }, { status: 201 });
  } catch (error) {
    console.error("Failed to add vendor to event:", error);
    return NextResponse.json({ error: "Failed to add vendor" }, { status: 500 });
  }
}

// PATCH - Update vendor status/info for an event
export async function PATCH(request: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const body = await request.json() as Record<string, unknown>;
    const { eventVendorId, status, boothInfo } = body;

    if (!eventVendorId) {
      return NextResponse.json({ error: "Event vendor ID is required" }, { status: 400 });
    }

    const db = getCloudflareDb();

    const updateData: Record<string, unknown> = {};
    if (status) updateData.status = status;
    if (boothInfo !== undefined) updateData.boothInfo = boothInfo;

    await db
      .update(eventVendors)
      .set(updateData)
      .where(and(
        eq(eventVendors.id, eventVendorId as string),
        eq(eventVendors.eventId, id)
      ));

    const updated = await db
      .select()
      .from(eventVendors)
      .leftJoin(vendors, eq(eventVendors.vendorId, vendors.id))
      .where(eq(eventVendors.id, eventVendorId as string))
      .limit(1);

    return NextResponse.json({
      ...updated[0].event_vendors,
      vendor: updated[0].vendors,
    });
  } catch (error) {
    console.error("Failed to update event vendor:", error);
    return NextResponse.json({ error: "Failed to update vendor" }, { status: 500 });
  }
}

// DELETE - Remove a vendor from an event
export async function DELETE(request: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const { searchParams } = new URL(request.url);
    const eventVendorId = searchParams.get("eventVendorId");

    if (!eventVendorId) {
      return NextResponse.json({ error: "Event vendor ID is required" }, { status: 400 });
    }

    const db = getCloudflareDb();

    await db
      .delete(eventVendors)
      .where(and(
        eq(eventVendors.id, eventVendorId),
        eq(eventVendors.eventId, id)
      ));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to remove vendor from event:", error);
    return NextResponse.json({ error: "Failed to remove vendor" }, { status: 500 });
  }
}
