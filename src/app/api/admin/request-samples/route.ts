export const dynamic = "force-dynamic";
/**
 * A9 (2026-06-26) — read the edge request samples (src/middleware.ts +
 * request-sampling.ts) for a date window, grouped so the recurring
 * 21st-of-month bot's fingerprint stands out: high-count `(asn, as_organization,
 * user_agent)` tuples hitting a small set of distinct paths. Feed the winning
 * ASN/UA into a WAF Managed-Challenge rule + GA4 filter (see
 * docs/a9-bot-traffic-playbook.md). Counts are of the SAMPLED slice — multiply
 * by ~1/sample_rate for a population estimate.
 *
 * Auth: admin session OR X-Internal-Key. Default window = last 7 days.
 */
import { NextResponse } from "next/server";
import { and, gte, lte, sql, desc } from "drizzle-orm";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { requestSamples } from "@/lib/db/schema";
import { REQUEST_SAMPLE_RATE } from "@/lib/request-sampling";

export async function GET(request: Request) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const now = Date.now();
  const sinceParam = url.searchParams.get("since");
  const untilParam = url.searchParams.get("until");
  const since = sinceParam ? new Date(sinceParam) : new Date(now - 7 * 86400 * 1000);
  const until = untilParam ? new Date(untilParam) : new Date(now);
  if (isNaN(since.getTime()) || isNaN(until.getTime())) {
    return NextResponse.json({ success: false, error: "invalid_date" }, { status: 400 });
  }

  const db = getCloudflareDb();
  const where = and(gte(requestSamples.timestamp, since), lte(requestSamples.timestamp, until));

  const [{ total }] = await db
    .select({ total: sql<number>`COUNT(*)` })
    .from(requestSamples)
    .where(where);

  // Bot fingerprint: the highest-volume (asn, org, ua) tuples. A crawler walking
  // a fixed URL list shows a high count across few distinct paths.
  const fingerprints = await db
    .select({
      asn: requestSamples.asn,
      asOrganization: requestSamples.asOrganization,
      userAgent: requestSamples.userAgent,
      count: sql<number>`COUNT(*)`,
      distinctPaths: sql<number>`COUNT(DISTINCT ${requestSamples.path})`,
      firstSeen: sql<number>`MIN(${requestSamples.timestamp})`,
      lastSeen: sql<number>`MAX(${requestSamples.timestamp})`,
    })
    .from(requestSamples)
    .where(where)
    .groupBy(requestSamples.asn, requestSamples.asOrganization, requestSamples.userAgent)
    .orderBy(desc(sql`COUNT(*)`))
    .limit(50);

  const topPaths = await db
    .select({ path: requestSamples.path, count: sql<number>`COUNT(*)` })
    .from(requestSamples)
    .where(where)
    .groupBy(requestSamples.path)
    .orderBy(desc(sql`COUNT(*)`))
    .limit(25);

  return NextResponse.json({
    success: true,
    since: since.toISOString(),
    until: until.toISOString(),
    sample_rate: REQUEST_SAMPLE_RATE,
    total,
    fingerprints,
    top_paths: topPaths,
  });
}
