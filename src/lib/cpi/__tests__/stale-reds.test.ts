import { describe, expect, it } from "vitest";
import type { ActionQueueEntry } from "@/lib/analytics-overview/types";
import {
  STALE_THRESHOLD_HOURS,
  formatStaleRedDigest,
  selectStaleFaultReds,
  selectStaleReds,
  type FaultRedInput,
  staleRedFingerprint,
  type StaleRed,
} from "@/lib/cpi/stale-reds";

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
    // OPE-78 added these derived fields to ActionQueueEntry; selectStaleReds
    // (OPE-75) computes its own age from firstDetectedAt and ignores them.
    hoursInRed: hoursAgo,
    slaStatus: "none",
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

/** Build a FaultRedInput first seen `hoursAgo` before NOW. */
function faultRow(
  status: string,
  hoursAgo: number,
  overrides: Partial<FaultRedInput> = {}
): FaultRedInput {
  return {
    signature: `sig-${status}-${hoursAgo}`,
    route: "/events/[slug]",
    status,
    firstSeen: NOW.getTime() - hoursAgo * 3_600_000,
    ...overrides,
  };
}

describe("selectStaleFaultReds", () => {
  it("includes an over-threshold proposed fault as P0 (> 24h)", () => {
    const reds = selectStaleFaultReds([faultRow("proposed", 30)], NOW);
    expect(reds).toHaveLength(1);
    expect(reds[0].priority).toBe("P0");
    expect(reds[0].hoursInRed).toBeCloseTo(30, 5);
    expect(reds[0].href).toBe("/admin/analytics#render-fault-health");
    expect(reds[0].refKey).toBe("sig-proposed-30");
  });

  it("includes over-threshold filed and regressed faults", () => {
    expect(selectStaleFaultReds([faultRow("filed", 48)], NOW)).toHaveLength(1);
    expect(selectStaleFaultReds([faultRow("regressed", 48)], NOW)).toHaveLength(1);
  });

  it("excludes a done (resolved) fault even when very old", () => {
    expect(selectStaleFaultReds([faultRow("done", 500)], NOW)).toHaveLength(0);
  });

  it("excludes a sub-threshold fault (< 24h)", () => {
    expect(selectStaleFaultReds([faultRow("proposed", 20)], NOW)).toHaveLength(0);
  });

  it("excludes a fault exactly at the 24h threshold (strictly greater than)", () => {
    expect(selectStaleFaultReds([faultRow("proposed", 24)], NOW)).toHaveLength(0);
  });

  it("skips a NaN firstSeen without throwing", () => {
    const bad = faultRow("proposed", 100, { firstSeen: Number.NaN });
    expect(() => selectStaleFaultReds([bad], NOW)).not.toThrow();
    expect(selectStaleFaultReds([bad], NOW)).toHaveLength(0);
  });

  it("titles by route, falling back to the signature when route is null", () => {
    const [withRoute] = selectStaleFaultReds([faultRow("proposed", 30)], NOW);
    expect(withRoute.title).toBe("Render fault: /events/[slug]");
    const [noRoute] = selectStaleFaultReds(
      [faultRow("proposed", 30, { route: null, signature: "abc123" })],
      NOW
    );
    expect(noRoute.title).toBe("Render fault: abc123");
  });

  it("honors a custom threshold override", () => {
    // With a 72h override the 48h fault is now sub-threshold.
    expect(selectStaleFaultReds([faultRow("filed", 48)], NOW, 72)).toHaveLength(0);
    expect(selectStaleFaultReds([faultRow("filed", 80)], NOW, 72)).toHaveLength(1);
  });

  it("sorts longest-red first", () => {
    const reds = selectStaleFaultReds(
      [
        faultRow("proposed", 30, { signature: "young" }),
        faultRow("regressed", 500, { signature: "ancient" }),
        faultRow("filed", 100, { signature: "mid" }),
      ],
      NOW
    );
    expect(reds.map((r) => r.refKey)).toEqual(["ancient", "mid", "young"]);
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

  it("does not prefix an already-absolute href (OPE-261 §4)", () => {
    // The 2026-07-20 digest recovered from the inbound archive linked the
    // IndexNow red as `https://meetmeatthefair.comhttps://www.bing.com/...`
    // — the site base concatenated onto an absolute URL, so the operator's
    // one actionable link did not resolve.
    const reds = selectStaleReds(
      [
        entry("P0", 36 * 24, {
          title: "IndexNow submissions failing",
          href: "https://www.bing.com/webmasters",
          refKey: "indexnow",
        }),
      ],
      NOW
    );
    const digest = formatStaleRedDigest(reds, "https://meetmeatthefair.com");

    expect(digest.text).toContain("https://www.bing.com/webmasters");
    expect(digest.html).toContain('href="https://www.bing.com/webmasters"');
    // The signature of the bug, in both parts.
    expect(digest.text).not.toContain("comhttps");
    expect(digest.html).not.toContain("comhttps");
  });
});

describe("staleRedFingerprint (OPE-308)", () => {
  const red = (refKey: string, hoursInRed: number): StaleRed =>
    ({ refKey, hoursInRed }) as StaleRed;

  it("is stable when the same reds persist, so a persistent red stops re-mailing", () => {
    expect(staleRedFingerprint([red("a", 1), red("b", 2)])).toBe(
      staleRedFingerprint([red("a", 1), red("b", 2)])
    );
  });

  it("ignores hoursInRed — the clock advancing is NOT news", () => {
    // The whole point: without this, every scan looks like a change and the
    // daily mail comes back through the back door.
    expect(staleRedFingerprint([red("a", 5)])).toBe(staleRedFingerprint([red("a", 300)]));
  });

  it("ignores ordering, so the digest's own sort cannot fake a change", () => {
    expect(staleRedFingerprint([red("b", 1), red("a", 1)])).toBe(
      staleRedFingerprint([red("a", 1), red("b", 1)])
    );
  });

  it("changes when a NEW red appears — a new problem still pages", () => {
    expect(staleRedFingerprint([red("a", 1), red("b", 1)])).not.toBe(
      staleRedFingerprint([red("a", 1)])
    );
  });

  it("changes when a red clears — recovery is news too", () => {
    expect(staleRedFingerprint([red("a", 1)])).not.toBe(
      staleRedFingerprint([red("a", 1), red("b", 1)])
    );
  });

  it("does not collide across a swapped set of the same size", () => {
    expect(staleRedFingerprint([red("a", 1), red("b", 1)])).not.toBe(
      staleRedFingerprint([red("a", 1), red("c", 1)])
    );
  });

  it("is empty for no reds, which is what lets the KV key be cleared", () => {
    expect(staleRedFingerprint([])).toBe("");
  });
});

/**
 * OPE-308 follow-up — the render-fault exclusion.
 *
 * Measured in prod 2026-08-20: the digest count swung 11/12/13/14 on
 * consecutive days while the eight non-fault reds had not moved since 08-16.
 * The refKeys below are the real ones from `stale_red_signals`.
 */
describe("staleRedFingerprint — volatile render faults (OPE-308)", () => {
  const stable = (refKey: string): StaleRed => ({ refKey, hoursInRed: 100 }) as StaleRed;
  const fault = (refKey: string): StaleRed =>
    ({
      refKey,
      hoursInRed: 100,
      volatileSignature: true,
      priority: "P0",
      title: `Render fault: ${refKey.split("#")[0]}`,
      href: "/admin/analytics#render-fault-health",
      firstDetectedAt: NOW.toISOString(),
    }) as StaleRed;

  const STABLE_CORE = [
    stable("queue-freeze:vendor_enrichment"),
    stable("time_to_index_h"),
    stable("sitemap_quality"),
  ];

  it("does not move when a render fault is REWORDED — the churn that caused the daily mail", () => {
    // Same page, different browser error text => a different refKey. This is
    // the exact shape that rotated day to day in prod.
    expect(
      staleRedFingerprint([
        ...STABLE_CORE,
        fault("/events/warner-fall-foliage-festival/2026#undefined"),
      ])
    ).toBe(
      staleRedFingerprint([
        ...STABLE_CORE,
        fault(
          "/events/warner-fall-foliage-festival/2026#typeerror: undefined is not an object (evaluating )"
        ),
      ])
    );
  });

  it("does not move when a NEW render fault appears", () => {
    // 08-17 in prod: a fourth fault arrived and would have paged under the old rule.
    expect(staleRedFingerprint([...STABLE_CORE, fault("/login#script error.")])).toBe(
      staleRedFingerprint([
        ...STABLE_CORE,
        fault("/login#script error."),
        fault("/events/boston-carnival-caribbean-festival/2026#undefined"),
      ])
    );
  });

  it("still moves when a STABLE red appears, even while faults are churning", () => {
    // The reason for the whole change: standing problems must stay audible.
    expect(staleRedFingerprint([...STABLE_CORE, fault("/login#script error.")])).not.toBe(
      staleRedFingerprint([
        ...STABLE_CORE,
        stable("integration-silence:indexnow"),
        fault("/login#a totally different message"),
      ])
    );
  });

  it("still moves when a stable red CLEARS", () => {
    expect(staleRedFingerprint([...STABLE_CORE, fault("/login#x")])).not.toBe(
      staleRedFingerprint([STABLE_CORE[0], STABLE_CORE[1], fault("/login#x")])
    );
  });

  it("is empty when only faults are red, so faults alone never page", () => {
    expect(staleRedFingerprint([fault("/login#script error."), fault("/a#b")])).toBe("");
  });

  it("keeps faults OUT of the fingerprint but IN the digest body", () => {
    // The ruling was explicit that they stay visible. If this ever regresses to
    // filtering them out of the digest too, the operator silently loses them.
    const reds = [...STABLE_CORE, fault("/login#script error.")];
    const digest = formatStaleRedDigest(reds, "https://meetmeatthefair.com");
    expect(digest.text).toContain("Render fault: /login");
    expect(digest.html).toContain("Render fault: /login");
    // …and the subject still counts them, so the operator sees the true total.
    expect(digest.subject).toContain("4 dashboard signals");
  });

  it("selectStaleFaultReds MARKS its reds volatile — without this the exclusion is unreachable", () => {
    // The wiring test. The filter above is dead code in prod unless the fault
    // builder actually sets the flag, and nothing else in the scan does.
    const reds = selectStaleFaultReds([faultRow("proposed", 30)], NOW);
    expect(reds).toHaveLength(1);
    expect(reds[0].volatileSignature).toBe(true);
    expect(staleRedFingerprint(reds)).toBe("");
  });

  it("action-queue reds are NOT marked volatile — they must keep paging", () => {
    const reds = selectStaleReds([entry("P1", 100)], NOW);
    expect(reds.length).toBeGreaterThan(0);
    expect(reds[0].volatileSignature).toBeFalsy();
    expect(staleRedFingerprint(reds)).not.toBe("");
  });
});
