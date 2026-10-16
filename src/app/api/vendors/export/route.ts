export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { getCloudflareDb } from "@/lib/cloudflare";
import { vendors, eventVendors, events } from "@/lib/db/schema";
import { eq, and, inArray, isNull } from "drizzle-orm";
import { isPublicVendorStatus, isPubliclyVisibleVendorLink } from "@/lib/vendor-status";
import { isPublicEventStatus } from "@/lib/event-status";
import { upcomingEndPredicate } from "@/lib/event-dates";
import { parseJsonArray } from "@/types";
import { auth } from "@/lib/auth";
import { logError } from "@/lib/logger";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

export async function GET(request: Request) {
  // Rate limiting check
  const rateLimitResult = await checkRateLimit(request, "export-vendors");
  if (!rateLimitResult.allowed) {
    return rateLimitResponse(rateLimitResult);
  }

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // OPE-1362 — the export button sits on the public /vendors view and
  // registration is open, so "signed in" is not a trust boundary. Only ADMIN
  // gets the contact / internal columns; every other role gets the CSV with
  // those columns removed entirely (no header, not blanked).
  const isAdmin = session.user.role === "ADMIN";

  const db = getCloudflareDb();
  try {
    const { searchParams } = new URL(request.url);
    const type = searchParams.get("type");
    const hasEvents = searchParams.get("hasEvents");
    const query = searchParams.get("q");

    // OPE-1362 — soft-deleted vendors (drizzle/0053) are excluded for EVERY
    // role. This matches the public /vendors listing
    // (src/app/vendors/(listing)/page.tsx getVendorsOnce), whose only
    // row-level visibility filter is `deleted_at IS NULL`.
    const conditions = [isNull(vendors.deletedAt)];
    if (type) {
      conditions.push(eq(vendors.vendorType, type));
    }

    // Explicit projection: the CSV never needs the whole row.
    let vendorResults = await db
      .select({
        id: vendors.id,
        businessName: vendors.businessName,
        vendorType: vendors.vendorType,
        description: vendors.description,
        products: vendors.products,
        website: vendors.website,
        contactName: vendors.contactName,
        contactEmail: vendors.contactEmail,
        contactPhone: vendors.contactPhone,
        address: vendors.address,
        city: vendors.city,
        state: vendors.state,
        zip: vendors.zip,
        yearEstablished: vendors.yearEstablished,
        paymentMethods: vendors.paymentMethods,
        licenseInfo: vendors.licenseInfo,
        insuranceInfo: vendors.insuranceInfo,
        verified: vendors.verified,
        commercial: vendors.commercial,
      })
      .from(vendors)
      .where(and(...conditions))
      .orderBy(vendors.businessName);

    // Filter by search query if provided
    if (query) {
      const lowerQuery = query.toLowerCase();
      vendorResults = vendorResults.filter(
        (v) =>
          v.businessName.toLowerCase().includes(lowerQuery) ||
          v.description?.toLowerCase().includes(lowerQuery) ||
          v.vendorType?.toLowerCase().includes(lowerQuery)
      );
    }

    // Get event counts for all vendors
    const vendorIds = vendorResults.map((v) => v.id);
    const eventCounts = new Map<string, number>();

    if (vendorIds.length > 0) {
      // D1 has a limit on SQL bind variables, so batch large arrays
      const BATCH_SIZE = 50;
      for (let i = 0; i < vendorIds.length; i += BATCH_SIZE) {
        const batch = vendorIds.slice(i, i + BATCH_SIZE);
        const batchResults = await db
          .select({
            vendorId: eventVendors.vendorId,
          })
          .from(eventVendors)
          .innerJoin(events, eq(eventVendors.eventId, events.id))
          .where(
            and(
              inArray(eventVendors.vendorId, batch),
              // Non-admins count the same link set the public listing shows
              // (status AND the vendor's public_visible opt-out, OPE-316);
              // admins keep the operator view, where a hidden link still counts.
              isAdmin ? isPublicVendorStatus() : isPubliclyVisibleVendorLink(),
              isPublicEventStatus(),
              // OPE-1375 — the shared "upcoming" predicate (24h end-of-day
              // grace; NULL end falls back to start), same as /vendors.
              upcomingEndPredicate(new Date())
            )
          );

        for (const row of batchResults) {
          eventCounts.set(row.vendorId, (eventCounts.get(row.vendorId) || 0) + 1);
        }
      }
    }

    // Filter by hasEvents if requested
    let filteredVendors = vendorResults;
    if (hasEvents === "true") {
      filteredVendors = vendorResults.filter((v) => (eventCounts.get(v.id) || 0) > 0);
    }

    // Escape CSV values
    const escapeCSV = (value: string | number | boolean | null | undefined) => {
      if (value === null || value === undefined) return "";
      const str = String(value);
      if (str.includes(",") || str.includes('"') || str.includes("\n")) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    // Build CSV. `adminOnly` columns are personal contact data (contact
    // name/email/phone) or internal records the public vendor page does not
    // render (license, insurance). For non-admins they are dropped entirely.
    type VendorRow = (typeof vendorResults)[number];
    const columns: {
      header: string;
      adminOnly?: boolean;
      value: (v: VendorRow) => string | number | boolean | null | undefined;
    }[] = [
      { header: "Business Name", value: (v) => v.businessName },
      { header: "Type", value: (v) => v.vendorType },
      { header: "Description", value: (v) => v.description },
      { header: "Products", value: (v) => parseJsonArray(v.products).join("; ") },
      { header: "Website", value: (v) => v.website },
      { header: "Contact Name", adminOnly: true, value: (v) => v.contactName },
      { header: "Contact Email", adminOnly: true, value: (v) => v.contactEmail },
      { header: "Contact Phone", adminOnly: true, value: (v) => v.contactPhone },
      { header: "Address", value: (v) => v.address },
      { header: "City", value: (v) => v.city },
      { header: "State", value: (v) => v.state },
      { header: "ZIP", value: (v) => v.zip },
      { header: "Year Established", value: (v) => v.yearEstablished },
      { header: "Payment Methods", value: (v) => parseJsonArray(v.paymentMethods).join("; ") },
      { header: "License Info", adminOnly: true, value: (v) => v.licenseInfo },
      { header: "Insurance Info", adminOnly: true, value: (v) => v.insuranceInfo },
      { header: "Verified", value: (v) => (v.verified ? "Yes" : "No") },
      { header: "Commercial", value: (v) => (v.commercial ? "Yes" : "No") },
      { header: "Upcoming Events", value: (v) => eventCounts.get(v.id) || 0 },
    ];
    const exportColumns = isAdmin ? columns : columns.filter((c) => !c.adminOnly);

    const headers = exportColumns.map((c) => c.header);
    const rows = filteredVendors.map((v) => exportColumns.map((c) => escapeCSV(c.value(v))));

    const csvContent = [headers.join(","), ...rows.map((row) => row.join(","))].join("\n");

    return new NextResponse(csvContent, {
      headers: {
        "Content-Type": "text/csv;charset=utf-8",
        "Content-Disposition": `attachment; filename="vendors-${new Date().toISOString().split("T")[0]}.csv"`,
      },
    });
  } catch (error) {
    await logError(db, {
      message: "Error exporting vendors",
      error,
      source: "api/vendors/export",
      request,
    });
    return NextResponse.json({ error: "Failed to export vendors" }, { status: 500 });
  }
}
