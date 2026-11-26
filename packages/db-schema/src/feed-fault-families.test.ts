import { describe, expect, it } from "vitest";
import {
  buildFeedFaultFamilies,
  FEED_FAULT_FILE_THRESHOLD,
  weekStartUtc,
  type FeedFaultEvent,
} from "./feed-fault-families";

const NOW = new Date("2026-11-26T20:00:00Z"); // a Thursday
const ev = (
  family: FeedFaultEvent["family"],
  at: string,
  feedId: string | null = "f1"
): FeedFaultEvent => ({
  family,
  at: new Date(at),
  feedId,
  ref: `${family}@${at}`,
});

describe("weekStartUtc", () => {
  it("is the Monday 00:00 UTC of the week, Sunday belonging to the week before", () => {
    expect(new Date(weekStartUtc(NOW.getTime())).toISOString()).toBe("2026-11-23T00:00:00.000Z");
    expect(new Date(weekStartUtc(Date.parse("2026-11-29T23:59:00Z"))).toISOString()).toBe(
      "2026-11-23T00:00:00.000Z"
    );
    expect(new Date(weekStartUtc(Date.parse("2026-11-23T00:00:00Z"))).toISOString()).toBe(
      "2026-11-23T00:00:00.000Z"
    );
  });
});

describe("buildFeedFaultFamilies", () => {
  it("buckets per week oldest-first, counts the window, and counts distinct feeds", () => {
    const r = buildFeedFaultFamilies(
      [
        ev("feed-fetch-failed", "2026-11-24T06:00:00Z", "f1"),
        ev("feed-fetch-failed", "2026-11-25T06:00:00Z", "f2"),
        ev("feed-fetch-failed", "2026-11-17T06:00:00Z", "f1"),
        ev("feed-fetch-failed", "2026-10-01T06:00:00Z", "f1"), // outside 30d, inside 8 weeks
      ],
      { now: NOW }
    );
    const f = r.families.find((x) => x.id === "feed-fetch-failed")!;
    expect(f.weekly).toHaveLength(8);
    expect(f.weekly[7]).toEqual({ week_start: "2026-11-23", count: 2 });
    expect(f.weekly[6]).toEqual({ week_start: "2026-11-16", count: 1 });
    expect(f.weekly[0].week_start).toBe("2026-10-05");
    expect(f.count_window).toBe(3);
    expect(f.feeds_affected).toBe(2);
    expect(f.first_seen_at).toBe("2026-10-01T06:00:00.000Z");
    expect(r.occurrences_examined).toBe(4);
    expect(r.top).toEqual({ id: "feed-fetch-failed", count_window: 3, fileable: true });
  });

  it("every family at 0 → top is null, and no family is invented", () => {
    const r = buildFeedFaultFamilies([], { now: NOW });
    expect(r.top).toBeNull();
    expect(r.families).toHaveLength(7);
    expect(r.families.every((f) => f.count_window === 0 && f.last_seen_at === null)).toBe(true);
  });

  it("a tie breaks by registry order; below the threshold it is not fileable", () => {
    const r = buildFeedFaultFamilies(
      [
        ev("feed-wrong-venue", "2026-11-25T00:00:00Z"),
        ev("feed-format-drift", "2026-11-25T00:00:00Z"),
      ],
      { now: NOW }
    );
    expect(r.top).toEqual({ id: "feed-format-drift", count_window: 1, fileable: false });
    expect(FEED_FAULT_FILE_THRESHOLD).toBe(3);
  });

  it("ignores an occurrence stamped after now", () => {
    const r = buildFeedFaultFamilies([ev("feed-false-drop", "2026-11-27T00:00:00Z")], { now: NOW });
    expect(r.top).toBeNull();
  });
});
