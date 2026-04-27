import { NextResponse } from "next/server";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, eventVendors, vendors } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { isPublicVendorStatus } from "@/lib/vendor-status";
import { isPublicEventStatus } from "@/lib/event-status";
import { logError } from "@/lib/logger";

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const db = getCloudflareDb();
  try {
    const { slug } = await params;

    // Get event by slug
    const eventResults = await db
      .select({ id: events.id, name: events.name, slug: events.slug })
      .from(events)
      .where(and(eq(events.slug, slug), isPublicEventStatus()))
      .limit(1);

    if (eventResults.length === 0) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const event = eventResults[0];

    // Get approved vendors for this event
    const vendorResults = await db
      .select({
        id: vendors.id,
        businessName: vendors.businessName,
        slug: vendors.slug,
        vendorType: vendors.vendorType,
        logoUrl: vendors.logoUrl,
        description: vendors.description,
        verified: vendors.verified,
        products: vendors.products,
      })
      .from(eventVendors)
      .leftJoin(vendors, eq(eventVendors.vendorId, vendors.id))
      .where(and(eq(eventVendors.eventId, event.id), isPublicVendorStatus()));

    // Parse products JSON for each vendor
    const vendorsWithProducts = vendorResults
      .filter((v) => v.id !== null)
      .map((v) => ({
        ...v,
        products: parseProducts(v.products),
      }));

    return NextResponse.json({
      event: {
        id: event.id,
        name: event.name,
        slug: event.slug,
      },
      vendors: vendorsWithProducts,
    });
  } catch (error) {
    await logError(db, {
      message: "Error fetching event vendors",
      error,
      source: "api/events/[slug]/vendors",
      request,
    });
    return NextResponse.json({ error: "Failed to fetch vendors" }, { status: 500 });
  }
}

function parseProducts(products: unknown): string[] {
  if (!products) return [];
  if (Array.isArray(products)) return products;
  if (typeof products === "string") {
    try {
      const parsed = JSON.parse(products);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}
