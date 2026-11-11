import { describe, expect, it, vi } from "vitest";
import { buildFeedLaneMetrics, type FeedItemRow } from "@takemetothefair/db-schema";
import { formatFeedAge, loadFeedLaneTile, toFeedLaneTile } from "../feed-lane-tile";

vi.mock("@/lib/logger", () => ({ logError: vi.fn().mockResolvedValue(undefined) }));

const NOW = new Date("2026-11-11T19:00:00Z");
const D = 86_400_000;
const item = (over: Partial<FeedItemRow>): FeedItemRow => ({
  feedId: "f",
  eventId: null,
  included: true,
  exclusionReason: null,
  reviewState: "awaiting_review",
  firstSeenAt: new Date(NOW.getTime() - D / 2),
  lastSeenAt: NOW,
  startLocal: "2026-12-05",
  missingSince: null,
  eventPublic: null,
  ...over,
});

describe("toFeedLaneTile (OPE-1632)", () => {
  it("shapes the shared metrics: funnel segments sum to read, red marker past target", () => {
    const m = buildFeedLaneMetrics({
      now: NOW,
      windowDays: 30,
      feeds: [
        {
          id: "f",
          promoterId: "p",
          promoterName: "P",
          url: "https://p.example/feed",
          enabled: true,
          lastOkAt: NOW,
          pollIntervalHours: 6,
          consecutiveErrors: 0,
        },
      ],
      items: [
        item({}),
        item({ firstSeenAt: new Date(NOW.getTime() - 4 * D) }),
        item({ eventId: "e", reviewState: "linked", eventPublic: true }),
        item({ included: false, exclusionReason: "kids", reviewState: "dropped" }),
      ],
      changes: [],
      coverage: [{ promoterId: "p", ingestionMethod: null, feedLinked: true }],
    });
    const t = toFeedLaneTile(m);
    expect(t).toMatchObject({
      feedsEnabled: 1,
      feedsHealthy: 1,
      read: 4,
      matched: 1,
      fresh: 2,
      dropped: 1,
      awaitingReview: 2,
      oldestAgeDays: 4,
      pastTarget: true,
      targetDays: 3,
      coverageHealthyShare: 1,
      newToUs7d: 2,
    });
    expect(t.matched + t.fresh + t.dropped).toBe(t.read);
  });

  it("a failed read is null (the card shows '—'), not a zero tile", async () => {
    const db = {
      select: () => {
        throw new Error("D1 overloaded");
      },
    } as never;
    expect(await loadFeedLaneTile(db, NOW)).toBeNull();
  });

  it("formats the backlog age", () => {
    expect(formatFeedAge(null)).toBe("—");
    expect(formatFeedAge(0.4)).toBe("<1d");
    expect(formatFeedAge(2.9)).toBe("2d");
  });
});
