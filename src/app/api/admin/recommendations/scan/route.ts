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
// Default chunk size of 8 leaves ~22s of execution headroom for the
// slowest rules (HTTP fetches like hijacked_domain_detection). Callers
// can lower it via ?chunk=N if a single chunk is timing out.
const DEFAULT_CHUNK = 8;
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

  return NextResponse.json({
    success: true,
    data: {
      ...result,
      cursor,
      nextCursor,
      more,
      totalRules: ALL_RULES.length,
    },
  });
}
