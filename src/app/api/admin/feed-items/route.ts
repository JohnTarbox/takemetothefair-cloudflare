export const dynamic = "force-dynamic";
/**
 * OPE-1630 — GET the organizer-feed review queue (admin session or the MCP
 * Worker's X-Internal-Key; `list_feed_items`). Read-only.
 *
 * Query: feed_id?, promoter_id?, review_state? (default awaiting_review; "all"
 * for every state), limit? (≤ 50), offset?
 */
import { NextResponse } from "next/server";
import { withAuthorized } from "@/lib/api/with-auth";
import { LIST_MAX, REVIEW_STATES, listFeedItems, type ReviewState } from "@/lib/feed-review/review";

export const GET = withAuthorized(async ({ request, db }) => {
  const q = new URL(request.url).searchParams;
  const stateParam = q.get("review_state") ?? "awaiting_review";
  if (stateParam !== "all" && !REVIEW_STATES.includes(stateParam as ReviewState))
    return NextResponse.json(
      { error: `review_state must be one of ${REVIEW_STATES.join(", ")} or all` },
      { status: 400 }
    );
  const limit = Math.min(Number(q.get("limit") ?? 25) || 25, LIST_MAX);
  const offset = Math.max(Number(q.get("offset") ?? 0) || 0, 0);
  const items = await listFeedItems(db, {
    feedId: q.get("feed_id"),
    promoterId: q.get("promoter_id"),
    reviewState: stateParam === "all" ? null : (stateParam as ReviewState),
    limit,
    offset,
  });
  return NextResponse.json({
    review_state: stateParam,
    count: items.length,
    offset,
    next_offset: items.length === limit ? offset + limit : null,
    items,
  });
});
