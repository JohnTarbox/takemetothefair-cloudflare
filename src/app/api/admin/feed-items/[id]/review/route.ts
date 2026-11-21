export const dynamic = "force-dynamic";
/**
 * OPE-1630 — POST one review action on an organizer-feed item (admin session or
 * the MCP Worker's X-Internal-Key; `review_feed_item`). Audit-logged; sends no
 * email.
 *
 * JSON: { action: approve|approve_as_occurrence|link|reject, event_id?, series_id?, venue_id?,
 *         not_duplicate_of?, note?, actorUserId? }
 */
import { NextResponse } from "next/server";
import { withAuthorized } from "@/lib/api/with-auth";
import { REVIEW_ACTIONS, reviewFeedItem, type ReviewAction } from "@/lib/feed-review/review";

const STATUS_FOR: Record<string, number> = {
  not_found: 404,
  event_not_found: 404,
  series_not_found: 404,
  venue_not_found: 404,
  bad_request: 400,
  already_reviewed: 409,
  duplicate: 409,
  listed_by_another_organizer: 409,
};

export const POST = withAuthorized<{ id: string }>(async ({ request, db, userId, params }) => {
  let body: {
    action?: string;
    event_id?: string;
    series_id?: string;
    venue_id?: string;
    not_duplicate_of?: string;
    note?: string;
    actorUserId?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "expected JSON" }, { status: 400 });
  }
  if (!REVIEW_ACTIONS.includes(body.action as ReviewAction))
    return NextResponse.json(
      { error: `action must be one of ${REVIEW_ACTIONS.join(", ")}` },
      { status: 400 }
    );
  const result = await reviewFeedItem(db, {
    feedItemId: params.id,
    action: body.action as ReviewAction,
    eventId: body.event_id ?? null,
    seriesId: body.series_id ?? null,
    venueId: body.venue_id ?? null,
    notDuplicateOf: body.not_duplicate_of ?? null,
    note: body.note?.trim().slice(0, 1000) || null,
    actorUserId: userId ?? body.actorUserId ?? null,
    now: new Date(),
  });
  return NextResponse.json(result, { status: result.ok ? 200 : (STATUS_FOR[result.code] ?? 422) });
});
