export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { getCloudflareDb } from "@/lib/cloudflare";
import { getVendorEventsData } from "@/lib/vendors/vendor-events";
import { logError } from "@/lib/logger";

// Thin wrapper over the shared loader (OPE-40) — the /vendors/[slug]/events page
// now SSRs the same data, so both go through getVendorEventsData.
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const db = getCloudflareDb();
  try {
    const { slug } = await params;
    const data = await getVendorEventsData(db, slug);
    if (!data) {
      return NextResponse.json({ error: "Vendor not found" }, { status: 404 });
    }
    return NextResponse.json(data);
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
