import { describe, it, expect } from "vitest";
import {
  buildFeedLaneMetrics,
  feedLaneDigestLine,
  isFeedHealthy,
  median,
  REVIEW_NOT_MEASURED_REASON,
  type FeedItemRow,
  type FeedLaneInput,
  type FeedRow,
} from "./feed-lane-metrics";

const NOW = new Date("2026-11-11T19:00:00Z");
const READ = new Date("2026-11-11T14:20:00Z"); // the 2026-11-11 reads
const H = 3_600_000;
const D = 86_400_000;

const feed = (id: string, promoterId: string, over: Partial<FeedRow> = {}): FeedRow => ({
  id,
  promoterId,
  promoterName: promoterId,
  url: `https://${id}.example/feed`,
  enabled: true,
  lastOkAt: READ,
  pollIntervalHours: 6,
  consecutiveErrors: 0,
  ...over,
});

const item = (feedId: string, over: Partial<FeedItemRow> = {}): FeedItemRow => ({
  feedId,
  eventId: null,
  included: true,
  exclusionReason: null,
  reviewState: "awaiting_review",
  firstSeenAt: READ,
  lastSeenAt: READ,
  startLocal: "2026-12-05",
  missingSince: null,
  eventPublic: null,
  ...over,
});

const times = <T>(n: number, f: (k: number) => T) => Array.from({ length: n }, (_, k) => f(k));
const KIDS = "program matches /\\bkids?\\b/";

/** The 2026-11-11 prod reads, by the counts the ticket's acceptance names. */
function nov11(): FeedLaneInput {
  return {
    now: NOW,
    windowDays: 30,
    feeds: [
      feed("gurley", "p-gurley"),
      feed("marsh", "p-marsh"),
      feed("jenks", "p-jenks"),
      feed("saco", "p-saco"),
    ],
    items: [
      ...times(13, () => item("gurley")),
      ...times(7, () =>
        item("marsh", { included: false, exclusionReason: KIDS, reviewState: "dropped" })
      ),
      ...times(6, (k) =>
        item("jenks", { eventId: `j${k}`, reviewState: "linked", eventPublic: true })
      ),
      ...times(5, () => item("jenks")),
      // Saco: one linked item the filter picked, one it excluded but the ingest still linked.
      item("saco", { eventId: "s1", reviewState: "linked", eventPublic: true }),
      item("saco", {
        eventId: "s2",
        included: false,
        exclusionReason: KIDS,
        reviewState: "linked",
        eventPublic: false,
      }),
      ...times(4, () => item("saco")),
    ],
    changes: [],
    coverage: [],
  };
}

const step = (m: ReturnType<typeof buildFeedLaneMetrics>["total"], name: string) =>
  m.funnel.steps.find((s) => s.step === name)!;
const perFeed = (m: ReturnType<typeof buildFeedLaneMetrics>, id: string) =>
  m.per_feed.find((f) => f.feed_id === id)!;

describe("buildFeedLaneMetrics — the 2026-11-11 acceptance counts (OPE-1632)", () => {
  const m = buildFeedLaneMetrics(nov11());

  it("Gurley: 13 new", () => {
    expect(step(perFeed(m, "gurley"), "new").count).toBe(13);
    expect(step(perFeed(m, "gurley"), "matched").count).toBe(0);
  });

  it("Marshfield: 7 dropped, all by the kids rule", () => {
    const f = perFeed(m, "marsh");
    expect(step(f, "dropped").count).toBe(7);
    expect(f.funnel.dropped_by_rule).toEqual([{ rule: KIDS, count: 7 }]);
    expect(step(f, "included").count).toBe(0);
  });

  it("Jenks: 6 linked", () => {
    expect(step(perFeed(m, "jenks"), "matched").count).toBe(6);
    expect(step(perFeed(m, "jenks"), "published").count).toBe(6);
  });

  it("Saco: 2 linked — one of them OUTSIDE the inclusion filter, which is not 'dropped'", () => {
    const f = perFeed(m, "saco");
    expect(step(f, "matched").count).toBe(2);
    expect(f.funnel.matched_outside_filter).toBe(1);
    // An excluded item that matches a live event is watched, not dropped.
    expect(step(f, "dropped").count).toBe(0);
    expect(f.funnel.dropped_by_rule).toEqual([]);
    expect(step(f, "published").count).toBe(1);
  });

  it("totals add up, and each rate names its base", () => {
    const t = m.total;
    expect(step(t, "read").count).toBe(13 + 7 + 11 + 6);
    expect(step(t, "matched").count).toBe(8);
    expect(step(t, "new").count).toBe(13 + 5 + 4);
    expect(step(t, "dropped").count).toBe(7);
    // landmark: read = matched + new + dropped, every item is in exactly one bucket
    expect(step(t, "matched").count! + step(t, "new").count! + step(t, "dropped").count!).toBe(
      step(t, "read").count!
    );
    expect(step(t, "included")).toMatchObject({
      rate_base: "read",
      rate: Math.round((29 / 37) * 1000) / 1000,
    });
    expect(step(t, "new")).toMatchObject({
      rate_base: "included",
      rate: Math.round((22 / 29) * 1000) / 1000,
    });
    expect(step(t, "published")).toMatchObject({ count: 7, rate_base: "matched", rate: 0.875 });
    expect(m.coverage.new_to_us.value).toBe(22);
  });
});

describe("null, never 0", () => {
  it("reviewed / approved / rejected are null with a reason until OPE-1630 ships", () => {
    const m = buildFeedLaneMetrics(nov11());
    for (const name of ["reviewed", "approved", "rejected"]) {
      const s = step(m.total, name);
      expect(s.count).toBeNull();
      expect(s.rate).toBeNull();
      expect(s.reason).toBe(REVIEW_NOT_MEASURED_REASON);
    }
    // landmark: a measured step on the same output is a real number
    expect(step(m.total, "read").count).toBe(37);
  });

  it("an empty lane reports zero counts, but null ages / rates / lead time with reasons", () => {
    const m = buildFeedLaneMetrics({
      now: NOW,
      windowDays: 30,
      feeds: [],
      items: [],
      changes: [],
      coverage: [],
    });
    expect(step(m.total, "read").count).toBe(0);
    expect(step(m.total, "included").rate).toBeNull();
    expect(m.total.backlog.awaiting_review.value).toBe(0);
    expect(m.total.backlog.oldest_age_days).toMatchObject({
      value: null,
      reason: expect.any(String),
    });
    expect(m.total.backlog.median_age_days).toMatchObject({
      value: null,
      reason: expect.any(String),
    });
    expect(m.total.lead_time.median_days).toMatchObject({
      value: null,
      reason: expect.any(String),
    });
    expect(m.total.lead_time.share_under_14_days).toMatchObject({
      value: null,
      reason: expect.any(String),
    });
    expect(m.total.change_capture.before_event).toMatchObject({
      value: null,
      reason: expect.any(String),
    });
    expect(m.coverage.share_with_healthy_feed).toMatchObject({
      value: null,
      reason: expect.any(String),
    });
  });
});

describe("window boundaries", () => {
  const since = new Date(NOW.getTime() - 30 * D);

  it("an item last seen exactly at `since` is in the funnel; one millisecond earlier is not", () => {
    const m = buildFeedLaneMetrics({
      now: NOW,
      windowDays: 30,
      feeds: [feed("f", "p")],
      items: [
        item("f", { lastSeenAt: since, firstSeenAt: since }),
        item("f", {
          lastSeenAt: new Date(since.getTime() - 1),
          firstSeenAt: new Date(since.getTime() - 1),
        }),
      ],
      changes: [],
      coverage: [],
    });
    expect(step(m.total, "read").count).toBe(1);
    expect(m.coverage.new_to_us.value).toBe(1);
  });

  it("new_to_us_7d counts only items first seen in the last 7 days", () => {
    const m = buildFeedLaneMetrics({
      now: NOW,
      windowDays: 30,
      feeds: [feed("f", "p")],
      items: [
        item("f", { firstSeenAt: new Date(NOW.getTime() - 7 * D) }),
        item("f", { firstSeenAt: new Date(NOW.getTime() - 7 * D - 1) }),
      ],
      changes: [],
      coverage: [],
    });
    expect(m.coverage.new_to_us_7d.value).toBe(1);
    expect(m.coverage.new_to_us.value).toBe(2);
  });

  it("a discrepancy detected before the window is not counted; one on the day before the event counts as before", () => {
    const m = buildFeedLaneMetrics({
      now: NOW,
      windowDays: 30,
      feeds: [feed("f", "p")],
      items: [],
      changes: [
        {
          eventId: "e1",
          promoterId: "p",
          kind: "feed_dropped",
          detectedAt: new Date(since.getTime() - 1),
          eventStart: new Date("2026-12-01T00:00:00Z"),
        },
        {
          eventId: "e2",
          promoterId: "p",
          kind: "feed_cancelled",
          detectedAt: new Date("2026-11-30T23:00:00Z"),
          eventStart: new Date("2026-12-01T00:00:00Z"),
        },
        {
          eventId: "e3",
          promoterId: "p",
          kind: "feed_differs",
          detectedAt: new Date("2026-11-10T09:00:00Z"),
          eventStart: new Date("2026-11-10T00:00:00Z"),
        },
      ],
      coverage: [],
    });
    expect(m.total.change_capture.detected.value).toBe(2);
    expect(m.total.change_capture.cancellations.value).toBe(1);
    expect(m.total.change_capture.before_event.value).toBe(1); // e3 was caught on the event's own day
    expect(perFeed(m, "f").change_capture.detected.value).toBe(2);
  });
});

describe("backlog", () => {
  it("ages from first_seen_at, counts past the target, and excludes past / missing / disabled-feed items", () => {
    const m = buildFeedLaneMetrics({
      now: NOW,
      windowDays: 30,
      feeds: [feed("f", "p"), feed("off", "p2", { enabled: false })],
      items: [
        item("f", { firstSeenAt: new Date(NOW.getTime() - 5 * D) }),
        item("f", { firstSeenAt: new Date(NOW.getTime() - 1 * D) }),
        item("f", { firstSeenAt: new Date(NOW.getTime() - 2 * D) }),
        item("f", { startLocal: "2026-11-01" }), // past
        item("f", { missingSince: READ }), // left the feed
        item("f", { startLocal: null }), // undated
        item("off"), // disabled feed
      ],
      changes: [],
      coverage: [],
    });
    const b = m.total.backlog;
    expect(b.awaiting_review.value).toBe(3);
    expect(b.oldest_age_days.value).toBe(5);
    expect(b.median_age_days.value).toBe(2);
    expect(b.older_than_target.value).toBe(1);
    expect(b.target_days).toBe(3);
  });

  it("an item on today's date is still a live review task", () => {
    const m = buildFeedLaneMetrics({
      now: NOW,
      windowDays: 30,
      feeds: [feed("f", "p")],
      items: [item("f", { startLocal: "2026-11-11 18:00" })],
      changes: [],
      coverage: [],
    });
    expect(m.total.backlog.awaiting_review.value).toBe(1);
  });
});

describe("lead time", () => {
  it("whole days from first sighting to event date, ignoring events already past when seen", () => {
    const m = buildFeedLaneMetrics({
      now: NOW,
      windowDays: 30,
      feeds: [feed("f", "p")],
      items: [
        item("f", { firstSeenAt: new Date("2026-11-11T23:30:00Z"), startLocal: "2026-11-21" }), // 10
        item("f", { firstSeenAt: READ, startLocal: "2026-12-11" }), // 30
        item("f", { firstSeenAt: READ, startLocal: "2027-01-10 10:00" }), // 60
        item("f", { firstSeenAt: READ, startLocal: "2026-10-01" }), // past when seen — excluded
        item("f", { firstSeenAt: READ, startLocal: null }), // undated — excluded
      ],
      changes: [],
      coverage: [],
    });
    expect(m.total.lead_time.median_days.value).toBe(30);
    expect(m.total.lead_time.share_under_14_days.value).toBe(Math.round((1 / 3) * 1000) / 1000);
  });
});

describe("feed health and coverage", () => {
  it("healthy = enabled and read OK within max(24h, 2 × poll interval)", () => {
    expect(isFeedHealthy(feed("a", "p", { lastOkAt: new Date(NOW.getTime() - 24 * H) }), NOW)).toBe(
      true
    );
    expect(
      isFeedHealthy(feed("a", "p", { lastOkAt: new Date(NOW.getTime() - 24 * H - 1) }), NOW)
    ).toBe(false);
    expect(
      isFeedHealthy(
        feed("a", "p", { pollIntervalHours: 24, lastOkAt: new Date(NOW.getTime() - 47 * H) }),
        NOW
      )
    ).toBe(true);
    expect(isFeedHealthy(feed("a", "p", { enabled: false }), NOW)).toBe(false);
    expect(isFeedHealthy(feed("a", "p", { lastOkAt: null }), NOW)).toBe(false);
  });

  it("coverage shares use upcoming public events as the base", () => {
    const m = buildFeedLaneMetrics({
      now: NOW,
      windowDays: 30,
      feeds: [
        feed("f", "p-feed"),
        feed("stale", "p-stale", { lastOkAt: new Date(NOW.getTime() - 10 * D) }),
      ],
      items: [],
      changes: [],
      coverage: [
        { promoterId: "p-feed", ingestionMethod: "web_research", feedLinked: true },
        { promoterId: "p-feed", ingestionMethod: "email_submission", feedLinked: false },
        { promoterId: "p-stale", ingestionMethod: "web_research", feedLinked: true },
        { promoterId: "p-other", ingestionMethod: null, feedLinked: false },
      ],
    });
    expect(m.coverage.upcoming_public_events).toBe(4);
    expect(m.coverage.share_with_healthy_feed.value).toBe(0.5);
    expect(m.coverage.share_feed_linked.value).toBe(0.5);
    expect(m.coverage.by_ingestion_method).toEqual([
      { method: "web_research", count: 2 },
      { method: "(unrecorded)", count: 1 },
      { method: "email_submission", count: 1 },
    ]);
    expect(m.feeds).toMatchObject({ registered: 2, enabled: 2, healthy: 1 });
  });
});

describe("feedLaneDigestLine", () => {
  it("reads like the ticket's example", () => {
    const input = nov11();
    input.items.push(item("gurley", { firstSeenAt: new Date(NOW.getTime() - 2.5 * D) }));
    expect(feedLaneDigestLine(buildFeedLaneMetrics(input))).toBe(
      "Feeds: 4 of 4 healthy, 23 awaiting review (oldest 2d), 23 new to us this week (get_feed_lane_metrics, OPE-1632)."
    );
  });

  it("omits the age when nothing is waiting", () => {
    const m = buildFeedLaneMetrics({
      now: NOW,
      windowDays: 30,
      feeds: [feed("f", "p")],
      items: [],
      changes: [],
      coverage: [],
    });
    expect(feedLaneDigestLine(m)).toBe(
      "Feeds: 1 of 1 healthy, 0 awaiting review, 0 new to us this week (get_feed_lane_metrics, OPE-1632)."
    );
  });
});

describe("median", () => {
  it("handles odd, even and empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});
