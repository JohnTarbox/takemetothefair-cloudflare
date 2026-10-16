export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { getCloudflareDb } from "@/lib/cloudflare";
import { lookupVendorEvents } from "@/lib/vendors/vendor-events";
import { logError } from "@/lib/logger";

// Thin wrapper over the shared loader (OPE-40) — the /vendors/[slug]/events page
// now SSRs the same data (getVendorEventsData → lookupVendorEvents).
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const db = getCloudflareDb();
  try {
    const { slug } = await params;
    const result = await lookupVendorEvents(db, slug);
    if (result.kind === "missing") {
      return NextResponse.json({ error: "Vendor not found" }, { status: 404 });
    }
    // OPE-1396 (API5) — a soft-deleted vendor's page is 410 Gone (middleware);
    // its event list says the same thing instead of serving 200.
    if (result.kind === "gone") {
      return NextResponse.json({ error: "Vendor removed" }, { status: 410 });
    }
    return NextResponse.json(result.data);
  } catch (error) {
    await logError(db, {
      message: "Error fetching vendor events",
      error,
      source: "api/vendors/[slug]/events",
      request,
    });
    return NextResponse.json({ error: "Failed to fetch events" }, { status: 500 });
  }
}
