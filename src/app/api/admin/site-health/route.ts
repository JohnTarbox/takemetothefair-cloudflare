import { NextResponse } from "next/server";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { getCurrentIssues, type HealthSeverity, type HealthSource } from "@/lib/site-health";

export const runtime = "edge";

export async function GET(request: Request) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const sourceParam = url.searchParams.get("source");
  const severityParam = url.searchParams.get("severity");
  const hideSnoozed = url.searchParams.get("hideSnoozed") === "1";

  const validSources: HealthSource[] = [
    "BING_SCAN",
    "BING_SITEMAP",
    "GSC_SITEMAP",
    "GSC_URL_INSPECTION",
  ];
  const validSeverities: HealthSeverity[] = ["ERROR", "WARNING", "NOTICE"];

  const source = validSources.includes(sourceParam as HealthSource)
    ? (sourceParam as HealthSource)
    : undefined;
  const severity = validSeverities.includes(severityParam as HealthSeverity)
    ? (severityParam as HealthSeverity)
    : undefined;

  const db = getCloudflareDb();
  const issues = await getCurrentIssues(db, { source, severity, hideSnoozed });
  return NextResponse.json({ success: true, data: { issues } });
}
