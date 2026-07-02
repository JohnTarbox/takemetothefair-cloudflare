export const dynamic = "force-dynamic";
// OPE-50 — import a Bing Webmaster Tools "Referring Domains" CSV export into D1.
// Bing's API has no backlink data, so the operator exports the BWT report and
// POSTs its CSV body here. Parsed + normalised, then upserted keyed on
// (referring_domain, snapshot_date) so re-imports update in place.
import { NextResponse } from "next/server";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { parseReferringDomainsCsv, importReferringDomains } from "@/lib/bing-backlinks-store";

/** UTC YYYY-MM-DD for today. Date.now()/new Date() are fine in route runtime. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function POST(request: Request) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    csv?: string;
    snapshot_date?: string;
  };

  if (typeof body.csv !== "string" || body.csv.trim() === "") {
    return NextResponse.json(
      { success: false, error: "bad_request", message: "csv is required" },
      { status: 400 }
    );
  }

  const snapshotDate =
    typeof body.snapshot_date === "string" && body.snapshot_date.trim() !== ""
      ? body.snapshot_date.trim()
      : todayUtc();

  try {
    const rows = parseReferringDomainsCsv(body.csv);
    const { imported } = await importReferringDomains(getCloudflareDb(), rows, snapshotDate);
    return NextResponse.json({ success: true, imported, snapshot_date: snapshotDate });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: "unknown", message }, { status: 500 });
  }
}
