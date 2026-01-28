import { NextResponse } from "next/server";
import { getCloudflareDb } from "@/lib/cloudflare";
import { vendors, eventVendors, events } from "@/lib/db/schema";
import { eq, and, gte, inArray } from "drizzle-orm";
import { parseJsonArray } from "@/types";

export const runtime = "edge";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const type = searchParams.get("type");
    const hasEvents = searchParams.get("hasEvents");
    const query = searchParams.get("q");

    const db = getCloudflareDb();

    // Build conditions
    const conditions: ReturnType<typeof eq>[] = [];
    if (type) {
      conditions.push(eq(vendors.vendorType, type));
    }

    // Get vendors
    let vendorResults;
    if (conditions.length > 0) {
      vendorResults = await db
        .select()
        .from(vendors)
        .where(and(...conditions))
        .orderBy(vendors.businessName);
    } else {
      vendorResults = await db
        .select()
        .from(vendors)
        .orderBy(vendors.businessName);
    }

    // Filter by search query if provided
    if (query) {
      const lowerQuery = query.toLowerCase();
      vendorResults = vendorResults.filter(v =>
        v.businessName.toLowerCase().includes(lowerQuery) ||
        v.description?.toLowerCase().includes(lowerQuery) ||
        v.vendorType?.toLowerCase().includes(lowerQuery)
      );
    }

    // Get event counts for all vendors
    const vendorIds = vendorResults.map(v => v.id);
    const eventCounts = new Map<string, number>();

    if (vendorIds.length > 0) {
      const vendorEventCounts = await db
        .select({
          vendorId: eventVendors.vendorId,
        })
        .from(eventVendors)
        .innerJoin(events, eq(eventVendors.eventId, events.id))
        .where(
          and(
            inArray(eventVendors.vendorId, vendorIds),
            eq(eventVendors.status, "APPROVED"),
            eq(events.status, "APPROVED"),
            gte(events.endDate, new Date())
          )
        );

      for (const row of vendorEventCounts) {
        eventCounts.set(row.vendorId, (eventCounts.get(row.vendorId) || 0) + 1);
      }
    }

    // Filter by hasEvents if requested
    let filteredVendors = vendorResults;
    if (hasEvents === "true") {
      filteredVendors = vendorResults.filter(v => (eventCounts.get(v.id) || 0) > 0);
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

    // Build CSV
    const headers = [
      "Business Name", "Type", "Description", "Products", "Website",
      "Contact Name", "Contact Email", "Contact Phone",
      "Address", "City", "State", "ZIP",
      "Year Established", "Payment Methods", "License Info", "Insurance Info",
      "Verified", "Commercial", "Upcoming Events"
    ];
    const rows = filteredVendors.map((v) => {
      const products = parseJsonArray(v.products);
      const paymentMethods = parseJsonArray(v.paymentMethods);
      return [
        escapeCSV(v.businessName),
        escapeCSV(v.vendorType),
        escapeCSV(v.description),
        escapeCSV(products.join("; ")),
        escapeCSV(v.website),
        escapeCSV(v.contactName),
        escapeCSV(v.contactEmail),
        escapeCSV(v.contactPhone),
        escapeCSV(v.address),
        escapeCSV(v.city),
        escapeCSV(v.state),
        escapeCSV(v.zip),
        escapeCSV(v.yearEstablished),
        escapeCSV(paymentMethods.join("; ")),
        escapeCSV(v.licenseInfo),
        escapeCSV(v.insuranceInfo),
        escapeCSV(v.verified ? "Yes" : "No"),
        escapeCSV(v.commercial ? "Yes" : "No"),
        escapeCSV(eventCounts.get(v.id) || 0),
      ];
    });

    const csvContent = [headers.join(","), ...rows.map((row) => row.join(","))].join("\n");

    return new NextResponse(csvContent, {
      headers: {
        "Content-Type": "text/csv;charset=utf-8",
        "Content-Disposition": `attachment; filename="vendors-${new Date().toISOString().split("T")[0]}.csv"`,
      },
    });
  } catch (error) {
    console.error("Error exporting vendors:", error);
    return NextResponse.json({ error: "Failed to export vendors" }, { status: 500 });
  }
}
