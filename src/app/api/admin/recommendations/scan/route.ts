import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getAuthorizedSession } from "@/lib/api-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { scanAll } from "@/lib/recommendations/engine";
import { ALL_RULES } from "@/lib/recommendations/rules";

export const runtime = "edge";

// Chunked scan to fit inside Cloudflare's 30s per-request budget.
//
// The full 23-rule scan exceeded 30s in production today (PR #150 made the
// silent-timeout visible via last_scan_error: 14 rules completed, 9 never
// reached). Clients now POST with ?cursor=N to scan a slice, then loop
// until `more: false`. Server slices ALL_RULES[cursor:cursor+chunk] and
// runs scanAll on that subset — scanAll already accepts a defs array.
//
// Default chunk size lowered 8 → 3 on 2026-05-19 evening: 5 of the ~27
// rules do HTTP fetches (hijacked_domain_detection, cannibalization_detection,
// seo_position_11_20, events_missing_application_url, static_pages_short_description)
// and when two land in the same chunk the combined wall time pushed past
// the 30s edge cap, taking the other 6 rules in the chunk down with them.
// chunk=3 almost guarantees at most one fetch-heavy rule per chunk.
// Pair this with the per-rule 12s timeout in scanAll (PER_RULE_TIMEOUT_MS)
// — together they bound chunk wall time to ~36s worst-case, well within
// edge's 30s response budget for a chunk containing fast rules + the
// per-rule timeout for one fetch rule.
const DEFAULT_CHUNK = 3;
const MAX_CHUNK = ALL_RULES.length;

export async function POST(request: Request) {
  const authz = await getAuthorizedSession(request);
  if (!authz.authorized) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const session = await auth();
  if (session && session.user.role !== "ADMIN" && !authz.userId) {
    return NextResponse.json({ success: false, error: "forbidden" }, { status: 403 });
  }

  const url = new URL(request.url);
  const cursor = Math.max(0, parseInt(url.searchParams.get("cursor") ?? "0", 10) || 0);
  const requestedChunk = parseInt(url.searchParams.get("chunk") ?? String(DEFAULT_CHUNK), 10);
  const chunk = Math.max(
    1,
    Math.min(Number.isFinite(requestedChunk) ? requestedChunk : DEFAULT_CHUNK, MAX_CHUNK)
  );

  const slice = ALL_RULES.slice(cursor, cursor + chunk);
  const db = getCloudflareDb();
  const result = await scanAll(db, slice);

  const nextCursor = cursor + slice.length;
  const more = nextCursor < ALL_RULES.length;

  // REL3 (2026-06-08) — flat `{ruleKey: ms}` map, easier to consume
  // for the workflow's slow-rule WARN logging than digging through
  // perRule. Each entry is wall-clock ms for the rule's run() +
  // dedup + INSERT/UPDATE writes.
  const ruleTimings: Record<string, number> = {};
  for (const r of result.perRule) {
    ruleTimings[r.ruleKey] = r.ms;
  }

  return NextResponse.json({
    success: true,
    data: {
      ...result,
      cursor,
      nextCursor,
      more,
      totalRules: ALL_RULES.length,
      ruleTimings,
    },
  });
}
