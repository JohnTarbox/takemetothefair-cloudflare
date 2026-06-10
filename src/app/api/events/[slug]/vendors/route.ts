import { NextResponse } from "next/server";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, eventVendors, vendors } from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { isPublicVendorStatus } from "@/lib/vendor-status";
import { isPublicEventStatus } from "@/lib/event-status";
import { logError } from "@/lib/logger";
import { unsafeSlug } from "@/lib/utils";
import { resolveEventVendorTarget, dedupeByResolvedSlug } from "@/lib/event-vendor-display";

export const runtime = "edge";

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const db = getCloudflareDb();
  try {
    const { slug } = await params;

    // Get event by slug
    const eventResults = await db
      .select({ id: events.id, name: events.name, slug: events.slug })
      .from(events)
      .where(and(eq(events.slug, unsafeSlug(slug)), isPublicEventStatus()))
      .limit(1);

    if (eventResults.length === 0) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const event = eventResults[0];

    // Get approved vendors for this event. Hierarchy columns are selected to
    // drive the EH2 brand_parent collapse (resolveEventVendorTarget) and are
    // stripped from the response below.
    const vendorResults = await db
      .select({
        id: vendors.id,
        businessName: vendors.businessName,
        displayName: vendors.displayName,
        slug: vendors.slug,
        vendorType: vendors.vendorType,
        logoUrl: vendors.logoUrl,
        description: vendors.description,
        verified: vendors.verified,
        products: vendors.products,
        role: vendors.role,
        brandParentVendorId: vendors.brandParentVendorId,
        operatorParentVendorId: vendors.operatorParentVendorId,
        aliasOfVendorId: vendors.aliasOfVendorId,
        displayOverridePermitted: vendors.displayOverridePermitted,
        displayMode: vendors.displayMode,
      })
      .from(eventVendors)
      .leftJoin(vendors, eq(eventVendors.vendorId, vendors.id))
      .where(and(eq(eventVendors.eventId, event.id), isPublicVendorStatus()));

    const liveVendors = vendorResults.filter((v): v is typeof v & { id: string } => v.id !== null);

    // EH2 brand_parent collapse — load brand/operator parents and resolve each
    // vendor's public display target. brand_parent offices (LeafFilter) surface
    // as the brand name + hub slug; self/both/INDEPENDENT rows stay themselves.
    const parentIds = Array.from(
      new Set(
        liveVendors
          .filter((v) => v.role === "LOCAL_OFFICE")
          .flatMap((v) => [v.brandParentVendorId, v.operatorParentVendorId])
          .filter((x): x is string => x != null)
      )
    );
    const parentRows =
      parentIds.length > 0
        ? await db
            .select({
              id: vendors.id,
              slug: vendors.slug,
              role: vendors.role,
              businessName: vendors.businessName,
              displayName: vendors.displayName,
              defaultChildDisplay: vendors.defaultChildDisplay,
            })
            .from(vendors)
            .where(inArray(vendors.id, parentIds))
        : [];
    const parentById = new Map(parentRows.map((p) => [p.id, p]));

    // Resolve display target, then collapse the returned client shape:
    // displayName → resolved name, slug → resolved hub slug. The client
    // renders `displayName ?? businessName` linking to `slug`, so it needs no
    // change. Dedupe so two offices of one brand return a single row.
    const resolved = dedupeByResolvedSlug(
      liveVendors.map((v) => {
        // id-filtered above → the NOT NULL vendor columns are present; the
        // leftJoin just widens their static type to `| null`.
        const target = resolveEventVendorTarget(
          {
            role: v.role!,
            brandParentVendorId: v.brandParentVendorId,
            operatorParentVendorId: v.operatorParentVendorId,
            aliasOfVendorId: v.aliasOfVendorId,
            displayOverridePermitted: v.displayOverridePermitted!,
            displayMode: v.displayMode,
            slug: v.slug!,
            businessName: v.businessName!,
            displayName: v.displayName,
          },
          parentById.get(v.brandParentVendorId ?? "") ?? null,
          parentById.get(v.operatorParentVendorId ?? "") ?? null
        );
        return {
          id: v.id,
          businessName: v.businessName,
          displayName: target.name,
          slug: target.slug,
          vendorType: v.vendorType,
          logoUrl: v.logoUrl,
          description: v.description,
          verified: v.verified,
          products: parseProducts(v.products),
        };
      }),
      (v) => v.slug
    );

    return NextResponse.json({
      event: {
        id: event.id,
        name: event.name,
        slug: event.slug,
      },
      vendors: resolved,
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
