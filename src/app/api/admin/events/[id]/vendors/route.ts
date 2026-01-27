import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { eventVendors, vendors } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { eventVendorAddSchema, eventVendorUpdateSchema, validateRequestBody } from "@/lib/validations";

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

  // Validate request body
  const validation = await validateRequestBody(request, eventVendorAddSchema);
  if (!validation.success) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const data = validation.data;

  try {
    const db = getCloudflareDb();

    // Check if vendor is already added to this event
    const existing = await db
      .select()
      .from(eventVendors)
      .where(and(
        eq(eventVendors.eventId, id),
        eq(eventVendors.vendorId, data.vendorId)
      ))
      .limit(1);

    if (existing.length > 0) {
      return NextResponse.json({ error: "Vendor is already added to this event" }, { status: 400 });
    }

    const eventVendorId = crypto.randomUUID();
    await db.insert(eventVendors).values({
      id: eventVendorId,
      eventId: id,
      vendorId: data.vendorId,
      status: data.status,
      boothInfo: data.boothInfo,
    });

    const [newEventVendor] = await db
      .select()
      .from(eventVendors)
      .leftJoin(vendors, eq(eventVendors.vendorId, vendors.id))
      .where(eq(eventVendors.id, eventVendorId))
      .limit(1);

    return NextResponse.json({
      ...newEventVendor.event_vendors,
      vendor: newEventVendor.vendors,
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

  // Validate request body
  const validation = await validateRequestBody(request, eventVendorUpdateSchema);
  if (!validation.success) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const data = validation.data;

  try {
    const db = getCloudflareDb();

    const updateData: Record<string, unknown> = {};
    if (data.status) updateData.status = data.status;
    if (data.boothInfo !== undefined) updateData.boothInfo = data.boothInfo;

    await db
      .update(eventVendors)
      .set(updateData)
      .where(and(
        eq(eventVendors.id, data.eventVendorId),
        eq(eventVendors.eventId, id)
      ));

    const [updated] = await db
      .select()
      .from(eventVendors)
      .leftJoin(vendors, eq(eventVendors.vendorId, vendors.id))
      .where(eq(eventVendors.id, data.eventVendorId))
      .limit(1);

    return NextResponse.json({
      ...updated.event_vendors,
      vendor: updated.vendors,
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
