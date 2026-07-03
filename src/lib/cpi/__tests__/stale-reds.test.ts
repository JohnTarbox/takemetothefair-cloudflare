import { describe, expect, it } from "vitest";
import type { ActionQueueEntry } from "@/lib/analytics-overview/types";
import { STALE_THRESHOLD_HOURS, formatStaleRedDigest, selectStaleReds } from "@/lib/cpi/stale-reds";

const NOW = new Date("2026-07-03T12:00:00.000Z");

/** Build an ActionQueueEntry that was first detected `hoursAgo` before NOW. */
function entry(
  priority: "P0" | "P1",
  hoursAgo: number | null,
  overrides: Partial<ActionQueueEntry> = {}
): ActionQueueEntry {
  const firstDetectedAt =
    hoursAgo === null ? null : new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();
  return {
    priority,
    source: "kpi",
    title: `${priority} signal`,
    effort: "Investigate",
    href: "/admin/analytics",
    firstDetectedAt,
    refKey: `${priority}-${hoursAgo}`,
    ...overrides,
  };
}

describe("selectStaleReds", () => {
  it("includes a P0 red for 25h (> 24h threshold)", () => {
    const reds = selectStaleReds([entry("P0", 25)], NOW);
    expect(reds).toHaveLength(1);
    expect(reds[0].priority).toBe("P0");
    expect(reds[0].hoursInRed).toBeCloseTo(25, 5);
  });

  it("excludes a P0 red for only 20h (< 24h threshold)", () => {
    expect(selectStaleReds([entry("P0", 20)], NOW)).toHaveLength(0);
  });

  it("excludes a P0 red exactly at the 24h threshold (strictly greater than)", () => {
    expect(selectStaleReds([entry("P0", 24)], NOW)).toHaveLength(0);
  });

  it("includes a P1 red for 80h (> 72h threshold)", () => {
    const reds = selectStaleReds([entry("P1", 80)], NOW);
    expect(reds).toHaveLength(1);
    expect(reds[0].priority).toBe("P1");
  });

  it("excludes a P1 red for 50h (< 72h threshold)", () => {
    expect(selectStaleReds([entry("P1", 50)], NOW)).toHaveLength(0);
  });

  it("excludes an entry with a null firstDetectedAt (no age → not stale)", () => {
    expect(selectStaleReds([entry("P0", null)], NOW)).toHaveLength(0);
  });

  it("excludes an entry with an unparseable firstDetectedAt without throwing", () => {
    const bad = entry("P0", 100, { firstDetectedAt: "not-a-date" });
    expect(() => selectStaleReds([bad], NOW)).not.toThrow();
    expect(selectStaleReds([bad], NOW)).toHaveLength(0);
  });

  it("sorts P0 before P1, then by hoursInRed descending within a priority", () => {
    const reds = selectStaleReds(
      [
        entry("P1", 100, { refKey: "p1-100" }),
        entry("P0", 30, { refKey: "p0-30" }),
        entry("P1", 200, { refKey: "p1-200" }),
        entry("P0", 500, { refKey: "p0-500" }),
      ],
      NOW
    );
    expect(reds.map((r) => r.refKey)).toEqual(["p0-500", "p0-30", "p1-200", "p1-100"]);
  });

  it("uses the ticket-specified thresholds", () => {
    expect(STALE_THRESHOLD_HOURS).toEqual({ P0: 24, P1: 72 });
  });

  // Time-to-index-style simulation: the exact IndexNow-silence case this
  // feature exists to catch. A P0 signal first detected 39 days ago WOULD
  // have fired daily instead of sitting silent for 2+ weeks.
  it("fires for a P0 red first detected 39 days ago (~936h)", () => {
    const reds = selectStaleReds(
      [entry("P0", 39 * 24, { title: "Time-to-index median regressed", refKey: "time_to_index" })],
      NOW
    );
    expect(reds).toHaveLength(1);
    expect(reds[0].hoursInRed).toBeCloseTo(936, 0);
    expect(reds[0].title).toBe("Time-to-index median regressed");
  });
});

describe("formatStaleRedDigest", () => {
  it("subject mentions the count and text includes each title + link", () => {
    const reds = selectStaleReds(
      [
        entry("P0", 39 * 24, {
          title: "Time-to-index median regressed",
          href: "/admin/analytics?tab=indexing",
          refKey: "time_to_index",
        }),
        entry("P1", 100, {
          title: "Site CTR below target",
          href: "/admin/analytics?tab=search",
          refKey: "site_ctr",
        }),
      ],
      NOW
    );
    const digest = formatStaleRedDigest(reds, "https://meetmeatthefair.com");

    expect(digest.subject).toContain("2");
    expect(digest.subject.toLowerCase()).toContain("red");

    // Each title + its deep link appears in the text body.
    expect(digest.text).toContain("Time-to-index median regressed");
    expect(digest.text).toContain("https://meetmeatthefair.com/admin/analytics?tab=indexing");
    expect(digest.text).toContain("Site CTR below target");
    expect(digest.text).toContain("https://meetmeatthefair.com/admin/analytics?tab=search");

    // 39d rounds to a "d" label; both priorities are surfaced.
    expect(digest.text).toContain("39d");
    expect(digest.html).toContain("[P0]");
    expect(digest.html).toContain("[P1]");
  });

  it("uses a singular subject for a single stale signal and no double slash in links", () => {
    const reds = selectStaleReds([entry("P0", 48)], NOW);
    const digest = formatStaleRedDigest(reds, "https://meetmeatthefair.com/");
    expect(digest.subject).toContain("1 dashboard signal ");
    expect(digest.text).toContain("https://meetmeatthefair.com/admin/analytics");
    expect(digest.text).not.toContain("com//admin");
  });
});
