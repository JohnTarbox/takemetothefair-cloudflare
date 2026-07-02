export const dynamic = "force-dynamic";
// OPE-50 — referring domains reader. Bing's API exposes NO backlink data
// (GetLinkCounts/GetUrlLinks/GetConnectedPages all live-probed empty
// 2026-07-02), so this route now reads the most-recent imported BWT
// "Referring Domains" CSV snapshot from D1 instead of calling the Bing API.
import { NextResponse } from "next/server";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { getLatestReferringDomains } from "@/lib/bing-backlinks-store";

export async function GET(request: Request) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const data = await getLatestReferringDomains(getCloudflareDb());
    return NextResponse.json({ success: true, data, source: "csv_import" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: "unknown", message }, { status: 500 });
  }
}
