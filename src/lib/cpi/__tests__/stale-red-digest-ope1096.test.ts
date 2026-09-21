/**
 * OPE-1096 — the digest reports what is still happening, grouped, at a honest
 * priority.
 *
 * The artefact that produced this ticket: `cpi.stale-red` on 2026-09-20, subject
 * **"⚠️ 239 dashboard signals stuck red"**, 43,601 characters. 224 of the 239
 * were render faults and **135 of those were a single incident on 2026-09-12**
 * — two D1 query failures fanned across 135 distinct routes, each minting its
 * own per-route signature. `first_seen` and `last_seen` were the same day. They
 * stopped nine days earlier and were still counted, because the signal asked
 * "does an unresolved signature exist" rather than "is this route faulting".
 *
 * Underneath sat ~10 real signals — KPI, queue-freeze, heartbeat — flat at 8–15
 * for six weeks. Those must survive every change here; suppressing them along
 * with the noise would be the worse failure.
 */
import { describe, it, expect } from "vitest";
import {
  formatStaleRedDigest,
  groupForDigest,
  selectStaleFaultReds,
  type FaultRedInput,
  type StaleRed,
} from "../stale-reds";

const NOW = new Date("2026-09-21T00:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function fault(over: Partial<FaultRedInput> & { signature: string }): FaultRedInput {
  return {
    route: "/events/[slug]",
    status: "filed",
    firstSeen: NOW.getTime() - 30 * HOUR,
    lastSeen: NOW.getTime() - 1 * HOUR,
    errorClass: "typeerror: null is not an object",
    ...over,
  };
}

describe("OPE-1096 — a fault that stopped recurring ages out", () => {
  it("ACCEPTANCE: the 2026-09-12 shape — seen once, 9 days ago — is no longer red", () => {
    const nineDaysAgo = NOW.getTime() - 9 * DAY;
    const reds = selectStaleFaultReds(
      [
        fault({
          signature: "sig-0912",
          firstSeen: nineDaysAgo,
          lastSeen: nineDaysAgo, // fired once, that day
          errorClass: "failed query: select count(*) from where (. = ? and . like ?)",
        }),
      ],
      NOW
    );
    expect(reds).toHaveLength(0);
  });

  it("…but the SAME age still counts if it is still firing — the landmark", () => {
    // Without this, "0 reds" above would be satisfied by a rule that simply
    // drops everything old, which would bury a long-running live outage.
    const reds = selectStaleFaultReds(
      [
        fault({
          signature: "sig-old-but-live",
          firstSeen: NOW.getTime() - 9 * DAY,
          lastSeen: NOW.getTime() - 2 * HOUR,
        }),
      ],
      NOW
    );
    expect(reds).toHaveLength(1);
    // Age-in-red is still measured from firstSeen — the window gates entry, it
    // does not rewrite how long the thing has been broken.
    expect(reds[0].hoursInRed).toBeCloseTo(9 * 24, 0);
  });

  it("the boundary is 7 days of silence", () => {
    const at6d = selectStaleFaultReds(
      [
        fault({
          signature: "a",
          firstSeen: NOW.getTime() - 10 * DAY,
          lastSeen: NOW.getTime() - 6 * DAY,
        }),
      ],
      NOW
    );
    const at8d = selectStaleFaultReds(
      [
        fault({
          signature: "b",
          firstSeen: NOW.getTime() - 10 * DAY,
          lastSeen: NOW.getTime() - 8 * DAY,
        }),
      ],
      NOW
    );
    expect(at6d).toHaveLength(1);
    expect(at8d).toHaveLength(0);
  });

  it("an unreadable lastSeen is treated as stale, not as a free pass", () => {
    const reds = selectStaleFaultReds([fault({ signature: "nan", lastSeen: Number.NaN })], NOW);
    expect(reds).toHaveLength(0);
  });
});

describe("OPE-1096 — priority stops being uniformly P0", () => {
  it("still firing inside 48h is P0; quiet for days is P1", () => {
    const reds = selectStaleFaultReds(
      [
        fault({ signature: "hot", lastSeen: NOW.getTime() - 3 * HOUR }),
        fault({
          signature: "cool",
          firstSeen: NOW.getTime() - 6 * DAY,
          lastSeen: NOW.getTime() - 5 * DAY,
        }),
      ],
      NOW
    );
    const byKey = Object.fromEntries(reds.map((r) => [r.refKey, r.priority]));
    expect(byKey.hot).toBe("P0");
    expect(byKey.cool).toBe("P1");
  });
});

describe("OPE-1096 — the digest groups by error class", () => {
  const incident = (n: number): StaleRed[] =>
    Array.from({ length: n }, (_, i) => ({
      priority: "P0" as const,
      title: `Render fault: /events/e${i}`,
      refKey: `sig-${i}`,
      href: "/admin/analytics#render-fault-health",
      firstDetectedAt: new Date(NOW.getTime() - 30 * HOUR).toISOString(),
      hoursInRed: 30 + i,
      groupKey: "failed query: select count(*) from where (. = ? and . like ?)",
    }));

  it("ACCEPTANCE: 135 routes of one incident become ONE line naming the count", () => {
    const grouped = groupForDigest(incident(135));
    expect(grouped).toHaveLength(1);
    expect(grouped[0].title).toBe(
      "failed query: select count(*) from where (. = ? and . like ?) — 135 routes"
    );
    // The group takes the longest age in it, not the first one encountered.
    expect(grouped[0].hoursInRed).toBe(30 + 134);
  });

  it("a single-route class keeps its route in the title — more useful than '1 route'", () => {
    const grouped = groupForDigest(incident(1));
    expect(grouped[0].title).toBe("Render fault: /events/e0");
  });

  it("one P0 in a group makes the whole line P0", () => {
    const rows = incident(3);
    rows[0].priority = "P1";
    rows[1].priority = "P1";
    rows[2].priority = "P0";
    expect(groupForDigest(rows)[0].priority).toBe("P0");
  });

  it("LANDMARK: signals with no groupKey pass through untouched", () => {
    // The ~10 KPI / queue-freeze / heartbeat signals. If grouping ever swallowed
    // these, the digest would look fixed and be blind.
    const kpi: StaleRed = {
      priority: "P0",
      title: "Sitemap quality is 57.44% (target ≥ 75%)",
      refKey: "sitemap-quality",
      href: "/admin/recommendations",
      firstDetectedAt: new Date(NOW.getTime() - 16 * DAY).toISOString(),
      hoursInRed: 16 * 24,
    };
    const frozen: StaleRed = {
      priority: "P1",
      title: "Vendor enrichment candidates: 3690 open, 0 closed in 7d (frozen)",
      refKey: "queue:vendor_enrichment",
      href: "/admin/analytics",
      firstDetectedAt: new Date(NOW.getTime() - 30 * DAY).toISOString(),
      hoursInRed: 30 * 24,
    };

    const grouped = groupForDigest([kpi, ...incident(135), frozen]);

    expect(grouped).toHaveLength(3); // kpi + one collapsed class + frozen
    expect(grouped.map((r) => r.refKey)).toEqual([
      "sitemap-quality",
      "sig-0",
      "queue:vendor_enrichment",
    ]);
    expect(grouped[0].title).toBe(kpi.title);
    expect(grouped[2].title).toBe(frozen.title);
  });
});

describe("OPE-1096 — the subject promises what the body delivers", () => {
  it("counts LINES, and says how many underlying signals they represent", () => {
    const rows = [
      {
        priority: "P0" as const,
        title: "Sitemap quality is 57.44% (target ≥ 75%)",
        refKey: "sitemap-quality",
        href: "/admin/recommendations",
        firstDetectedAt: new Date(NOW.getTime() - 16 * DAY).toISOString(),
        hoursInRed: 16 * 24,
      },
      ...Array.from({ length: 135 }, (_, i) => ({
        priority: "P0" as const,
        title: `Render fault: /events/e${i}`,
        refKey: `sig-${i}`,
        href: "/admin/analytics#render-fault-health",
        firstDetectedAt: new Date(NOW.getTime() - 30 * HOUR).toISOString(),
        hoursInRed: 30,
        groupKey: "failed query: select count(*)",
      })),
    ];

    const { subject, text } = formatStaleRedDigest(rows, "https://meetmeatthefair.com");

    // 136 signals → 2 lines. The old subject would have said 136.
    expect(subject).toBe("⚠️ 2 dashboard signals stuck red");
    expect(text).toContain("136 underlying signals, grouped by error.");
    expect(text.split("• ").length - 1).toBe(2);
  });

  it("says nothing about grouping when nothing was grouped", () => {
    const { subject, text } = formatStaleRedDigest(
      [
        {
          priority: "P0",
          title: "Conversion rate is 3.87% (target ≥ 8%)",
          refKey: "conversion",
          href: "/admin/analytics",
          firstDetectedAt: new Date(NOW.getTime() - 14 * DAY).toISOString(),
          hoursInRed: 14 * 24,
        },
      ],
      "https://meetmeatthefair.com"
    );
    expect(subject).toBe("⚠️ 1 dashboard signal stuck red");
    expect(text).not.toContain("underlying signals");
  });
});
