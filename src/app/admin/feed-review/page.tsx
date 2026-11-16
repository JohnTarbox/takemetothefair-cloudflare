/**
 * OPE-1630 item 3 — /admin/feed-review, the organizer-feed review queue.
 *
 * The scheduled reader (OPE-1626) marks a new event on a promoter's own calendar
 * `awaiting_review`; the daily operator notice and the /admin "Organizer feeds"
 * tile count them. Until now the only way to act on one was the MCP tools
 * `list_feed_items` / `review_feed_item`. This page lists the same items
 * (`listFeedItems`, the function behind the tool) and offers the same four
 * actions, posting to the same route the tool calls (`reviewFeedItem`). So the
 * page, the tool and the notice cannot disagree about what an action does.
 *
 * Server component. Admin auth is enforced HERE via requireAdmin(): the layout
 * check alone is skippable by a crafted RSC request (OPE-1365). An empty queue
 * renders an empty state, never a throw (the OPE-58 crash class).
 */
import Link from "next/link";
import { safeHref } from "@takemetothefair/utils";
import { requireAdmin } from "@/lib/require-admin";
import { getCloudflareDb } from "@/lib/cloudflare";
import { LIST_MAX, listFeedItems, type ListedFeedItem } from "@/lib/feed-review/review";
import { parseReviewState } from "@/lib/feed-review/parse-review-state";
import { Card, CardContent } from "@/components/ui/card";
import { FeedItemReviewActions } from "@/components/admin/FeedItemReviewActions";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ review_state?: string; feed_id?: string; offset?: string }>;

/** The page's query string. Callers prefix the literal route, so the href is provably internal. */
function stateQuery(state: string, feedId: string | null): string {
  const q = new URLSearchParams({ review_state: state });
  if (feedId) q.set("feed_id", feedId);
  return q.toString();
}

export default async function AdminFeedReviewPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const reviewState = parseReviewState(sp.review_state);
  const feedId = sp.feed_id?.trim() || null;
  const offset = Math.max(Number(sp.offset ?? 0) || 0, 0);

  const items = await listFeedItems(getCloudflareDb(), {
    feedId,
    reviewState: reviewState === "all" ? null : reviewState,
    limit: LIST_MAX,
    offset,
  });
  const nextOffset = items.length === LIST_MAX ? offset + LIST_MAX : null;

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-foreground">Organizer feed review</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Events a scheduled feed read found on a promoter&apos;s own calendar that match none of
          our listings. Nothing is created until you act. <strong>Approve</strong> creates the
          listing from the feed, cited to the item&apos;s URL. <strong>Occurrence</strong> adds it
          to an existing series. <strong>Link</strong> ties it to a listing we already have and
          changes no field. <strong>Reject</strong> is remembered, so later reads never ask again.
          Every action is audit-logged, and none sends email.
        </p>
      </header>

      <nav className="flex flex-wrap gap-2 text-sm" aria-label="Review state">
        {(["awaiting_review", "linked", "rejected", "dropped", "all"] as const).map((s) => (
          <Link
            prefetch={false}
            key={s}
            href={`/admin/feed-review?${stateQuery(s, feedId)}`}
            className={`px-3 py-1 rounded border ${
              s === reviewState
                ? "bg-navy text-white border-navy"
                : "border-border text-muted-foreground hover:bg-muted"
            }`}
          >
            {s.replace("_", " ")}
          </Link>
        ))}
        {feedId ? (
          <Link
            prefetch={false}
            href={`/admin/feed-review?${stateQuery(reviewState, null)}`}
            className="px-3 py-1 text-muted-foreground underline"
          >
            all feeds
          </Link>
        ) : null}
      </nav>

      {items.length === 0 ? (
        <Card>
          <CardContent
            className="p-6 text-sm text-muted-foreground"
            data-testid="feed-review-empty"
          >
            {reviewState === "awaiting_review"
              ? "Nothing is awaiting review. New feed events appear here after the next scheduled read."
              : "No items in this state."}
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-3">
          {items.map((item) => (
            <FeedItemRow key={item.id} item={item} feedFiltered={!!feedId} />
          ))}
        </ul>
      )}

      <div className="flex justify-between text-sm">
        {offset > 0 ? (
          <Link
            prefetch={false}
            href={`/admin/feed-review?${stateQuery(reviewState, feedId)}&offset=${Math.max(offset - LIST_MAX, 0)}`}
            className="underline"
          >
            ← previous
          </Link>
        ) : (
          <span />
        )}
        {nextOffset != null ? (
          <Link
            prefetch={false}
            href={`/admin/feed-review?${stateQuery(reviewState, feedId)}&offset=${nextOffset}`}
            className="underline"
          >
            next →
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function FeedItemRow({ item, feedFiltered }: { item: ListedFeedItem; feedFiltered: boolean }) {
  return (
    <li>
      <Card>
        <CardContent className="p-4 grid gap-4 md:grid-cols-[1fr_22rem]">
          <div className="space-y-1 min-w-0">
            <p className="font-semibold text-foreground break-words">
              {item.title ?? "(untitled)"}
            </p>
            <p className="text-sm text-muted-foreground">
              {item.start_local ?? "no date"} · {item.venue ?? "no venue given"}
            </p>
            <p className="text-xs text-muted-foreground">
              {feedFiltered ? (
                item.promoter
              ) : (
                <Link
                  prefetch={false}
                  href={`/admin/feed-review?${stateQuery(item.review_state, item.feed_id)}`}
                  className="underline"
                >
                  {item.promoter}
                </Link>
              )}
              {" · "}
              <span className="uppercase tracking-wide">{item.review_state.replace("_", " ")}</span>
              {item.inclusion_reason ? ` · ${item.inclusion_reason}` : ""}
            </p>
            {/* A feed-supplied URL: safeHref() keeps a javascript: value out of an admin session (OPE-1385). */}
            {safeHref(item.url) ? (
              <a
                href={safeHref(item.url)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-navy underline break-all"
              >
                {item.url}
              </a>
            ) : item.url ? (
              <p className="text-xs text-muted-foreground break-all">{item.url}</p>
            ) : null}
            {item.closest_event ? (
              <p className="text-xs text-amber-800" data-testid="feed-closest-event">
                Closest listing ({item.closest_event.match_type}):{" "}
                <a
                  href={`/events/${item.closest_event.slug}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  {item.closest_event.name}
                </a>
              </p>
            ) : null}
            {item.review_note ? (
              <p className="text-xs text-muted-foreground">Note: {item.review_note}</p>
            ) : null}
          </div>
          {item.review_state === "awaiting_review" || item.review_state === "dropped" ? (
            <FeedItemReviewActions
              feedItemId={item.id}
              closestEvent={
                item.closest_event
                  ? { id: item.closest_event.id, name: item.closest_event.name }
                  : null
              }
            />
          ) : item.event_id ? (
            <p className="text-sm text-muted-foreground">
              Linked to event <code className="text-xs">{item.event_id}</code>
            </p>
          ) : null}
        </CardContent>
      </Card>
    </li>
  );
}
