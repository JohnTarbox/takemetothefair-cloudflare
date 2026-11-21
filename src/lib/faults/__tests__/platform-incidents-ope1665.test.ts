/**
 * OPE-1665 — a D1 platform burst is ONE ledger row, not one per statement per route.
 *
 * The replay runs the emitter's own per-row step (`createFaultRowGrouper`, the
 * code the candidates route runs) over the 11-13 09:04:40Z burst, rebuilt from
 * prod `error_logs` (read 2026-11-17 ~14:40Z):
 *
 *   SELECT source, count(*), count(DISTINCT route), min/max(timestamp) - start,
 *          sum(… 'requests queued for too long')
 *     FROM error_logs WHERE timestamp BETWEEN 09:03:00 AND 09:06:00 GROUP BY source
 *
 * → 2,624 rows: 2,623 "D1 DB is overloaded" across 16 sources (950 of them
 *   render rows on 689 distinct routes) in 0–18s, plus ONE client row at +19s
 *   that is not a platform cause. Per-source volumes, the timing envelope and
 *   the cause text are real; the route strings are synthesized (the real 689
 *   carry visitors' query strings and are not committed).
 */
import { describe, expect, it } from "vitest";
import { createFaultRowGrouper, type FaultRowInput } from "../group-rows";
import {
  groupPlatformIncidents,
  isPlatformSignature,
  platformCause,
  reconcilePlatformIncidents,
} from "../platform-incidents";
import { reconcileFaults } from "../reconcile";
import { selectStaleFaultReds } from "../../cpi/stale-reds";

const T0 = Date.UTC(2026, 10, 13, 9, 4, 40); // 1794560680 s

/** [source, rows, distinct routes (render lane), first s, last s, "queued" variant rows] */
const BURST: Array<[string, number, number, number, number, number]> = [
  ["server-render", 950, 689, 0, 18, 15],
  ["app/performers/[slug]/page.tsx:getPerformer", 930, 0, 0, 17, 2],
  ["app/vendors/page.tsx:getVendors", 280, 0, 0, 17, 6],
  ["app/promoters/[slug]/page.tsx:getPromoter", 184, 0, 1, 17, 0],
  ["app/vendors/[slug]/page.tsx:getVendor", 149, 0, 1, 17, 0],
  ["app/venues/[slug]/page.tsx:getVenue", 115, 0, 1, 17, 1],
  ["app/venues/page.tsx:getVenues", 2, 0, 7, 7, 0],
  ["app/venues/page.tsx:getStates", 2, 0, 7, 7, 0],
  ["app/page.tsx:getWeekEvents", 2, 0, 7, 10, 0],
  ["app/page.tsx:getRecentBlogPosts", 2, 0, 7, 10, 0],
  ["app/events/page.tsx:getEvents", 2, 0, 7, 16, 0],
  ["app/vendors/[slug]/page.tsx:getSimilarVendors", 1, 0, 13, 13, 0],
  ["app/promoters/page.tsx:getPromoters", 1, 0, 12, 12, 0],
  ["app/page.tsx:getPlatformCounts", 1, 0, 7, 7, 0],
  ["app/page.tsx:getFeaturedEvents", 1, 0, 7, 7, 0],
  ["app/events/[slug]/page.tsx:getEvent", 1, 0, 17, 17, 0],
];

const RESOURCES = "D1 DB is overloaded. Too many resources consumed within a 10 second window.";
const QUEUED = "D1 DB is overloaded. Requests queued for too long.";

function row(o: Partial<FaultRowInput> & { message: string; tsMs: number }): FaultRowInput {
  return {
    message: o.message,
    route: o.route ?? null,
    source: o.source ?? null,
    digest: null,
    url: null,
    context: null,
    stackTrace: null,
    userAgent: null,
    timestamp: new Date(o.tsMs),
  };
}

function burstRows(): FaultRowInput[] {
  const out: FaultRowInput[] = [];
  for (const [source, n, routes, f, l, queued] of BURST) {
    for (let i = 0; i < n; i++) {
      const sec = n === 1 ? f : f + ((l - f) * i) / (n - 1);
      const cause = i < queued ? QUEUED : RESOURCES;
      // Distinct statements, as in prod: every row's SQL text differs.
      const sql = `Failed query: select "t${i}"."id" from "t${i}" where "id" = ? params: x${i}`;
      const message =
        source === "server-render"
          ? `Fetch failed (app/x/page.tsx:get${i})\ncause: ${sql}\ncause: D1_ERROR: ${cause}\ncause: ${cause}`
          : `Error fetching: ${sql}\ncause: D1_ERROR: ${cause}\ncause: ${cause}`;
      out.push(
        row({
          message,
          source,
          route: routes > 0 ? `/events/burst-route-${i % routes}?state=ME&page=${i}` : null,
          tsMs: T0 + sec * 1000,
        })
      );
    }
  }
  // The one non-platform row in the real window, verbatim.
  out.push(
    row({
      source: "client",
      route: "/claim/promoter/sustain-wayne",
      tsMs: T0 + 19_000,
      message:
        "An error occurred in the Server Components render. The specific message is omitted in production builds to avoid leaking sensitive details. A digest property is included on this error instance which may provide additional details about the nature of the error.",
    })
  );
  return out;
}

function runGrouper(rows: FaultRowInput[]) {
  const g = createFaultRowGrouper(T0 + 3_600_000);
  for (const r of rows) g.add(r);
  return g;
}

describe("replay — the 11-13 09:04Z burst", () => {
  it("2,623 overload rows become exactly ONE watch-bound incident with the input's counts", () => {
    const rows = burstRows();
    expect(rows).toHaveLength(2624); // landmark: the real window's size
    const g = runGrouper(rows);
    expect(g.platformHits()).toHaveLength(2623);

    const incidents = groupPlatformIncidents(g.platformHits());
    expect(incidents).toEqual([
      {
        cause: "overloaded",
        firstSeen: T0,
        lastSeen: T0 + 18_000,
        count: 2623,
        routes: 689,
        sources: 16,
      },
    ]);

    const ops = reconcilePlatformIncidents(incidents, []);
    expect(ops).toEqual([
      {
        op: "insert",
        signature: "d1-platform:overloaded@2026-11-13T09:04:40.000Z",
        errorClass: "d1-platform:overloaded",
        firstSeen: T0,
        lastSeen: T0 + 18_000,
        count: 2623,
        routes: 689,
        sources: 16,
      },
    ]);
  });

  it("…and none of them reaches per-statement grouping (was 2,000+ signatures)", () => {
    const g = runGrouper(burstRows());
    const grouped = g.grouped();
    // Only the non-platform client row is left as a signature of its own.
    expect(grouped).toHaveLength(1);
    expect(grouped[0].route).toBe("/claim/promoter/sustain-wayne");
  });

  it("a later scan that lost the burst's oldest rows MERGES into the same row; counts never shrink", () => {
    const g1 = runGrouper(burstRows());
    const [first] = reconcilePlatformIncidents(groupPlatformIncidents(g1.platformHits()), []);
    expect(first.op).toBe("insert");
    const ledger = [
      {
        signature: first.signature,
        firstSeen: first.firstSeen,
        lastSeen: first.lastSeen,
        count: first.count,
        incidentRoutes: 689,
        incidentSources: 16,
      },
    ];
    // The 5,000-row scan cap cuts the oldest 1,000 rows off the next read.
    const truncated = burstRows()
      .sort((a, b) => a.timestamp!.getTime() - b.timestamp!.getTime())
      .slice(1000);
    const g2 = runGrouper(truncated);
    const ops = reconcilePlatformIncidents(groupPlatformIncidents(g2.platformHits()), ledger);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      op: "merge",
      signature: first.signature,
      firstSeen: T0,
      count: 2623,
      routes: 689,
      sources: 16,
    });
  });
});

describe("mixed burst — platform collapsing must not hide a real defect", () => {
  it("our own error inside the same burst still proposes its own row", () => {
    const own = [0, 5_000, 10_000].map((dt) =>
      row({
        source: "app/vendors/page.tsx:getVendors",
        message: "TypeError: Cannot read properties of undefined (reading 'slug')",
        tsMs: T0 + dt,
      })
    );
    const g = runGrouper([...burstRows(), ...own]);
    const result = reconcileFaults(g.grouped(), [], new Date(T0 + 3_600_000));
    const proposed = result.upserts.filter((u) => u.op === "propose");
    expect(proposed).toHaveLength(1);
    expect(proposed[0].signature).toContain("app/vendors/page.tsx:getVendors#typeerror");
    // …and the burst is still one incident beside it.
    expect(groupPlatformIncidents(g.platformHits())).toHaveLength(1);
  });

  it("the needles are the platform's phrasing, not any similar words from our code", () => {
    expect(platformCause("cause: D1_ERROR: Network connection lost.")).toBe("network-lost");
    expect(platformCause("fetch to https://api.example.com failed: Network connection lost")).toBe(
      null
    );
    expect(platformCause("Workers AI timeout after 20000ms")).toBe(null);
    expect(platformCause("D1_ERROR: D1 DB exceeded its CPU time limit and was reset.")).toBe(
      "cpu-reset"
    );
    expect(
      platformCause(
        "Durable Object storage operation exceeded timeout which caused object to be reset."
      )
    ).toBe("storage-timeout");
    expect(platformCause(QUEUED)).toBe("overloaded");
    expect(platformCause(null)).toBe(null);
  });
});

describe("bursts", () => {
  it("rows more than 60s apart are separate incidents; a different cause is its own", () => {
    const hits = [
      { cause: "overloaded" as const, tsMs: T0, route: "/a", source: "s" },
      { cause: "overloaded" as const, tsMs: T0 + 59_000, route: "/b", source: "s" },
      { cause: "overloaded" as const, tsMs: T0 + 59_000 + 61_000, route: "/a", source: "s" },
      { cause: "cpu-reset" as const, tsMs: T0 + 1_000, route: null, source: "t" },
    ];
    const inc = groupPlatformIncidents(hits);
    expect(inc.map((i) => [i.cause, i.count, i.routes])).toEqual([
      ["overloaded", 2, 2],
      ["cpu-reset", 1, 0],
      ["overloaded", 1, 1],
    ]);
  });
});

describe("stale-red digest — an incident surfaces as one line", () => {
  const now = new Date(T0 + 30 * 3_600_000); // 30h later: past the 24h leash
  const base = { route: null, firstSeen: T0, lastSeen: T0 + 18_000 };

  it("a platform incident row (watch) is admitted once, as P1", () => {
    const reds = selectStaleFaultReds(
      [
        {
          ...base,
          signature: "d1-platform:overloaded@2026-11-13T09:04:40.000Z",
          status: "watch",
          errorClass: "d1-platform:overloaded",
        },
      ],
      now
    );
    expect(reds).toHaveLength(1);
    expect(reds[0].priority).toBe("P1");
    expect(reds[0].title).toContain("D1 platform incident");
    expect(reds[0].groupKey).toBe("d1-platform:overloaded");
  });

  it("an operator-parked (watch) ordinary row is still excluded", () => {
    const reds = selectStaleFaultReds(
      [{ ...base, signature: "/x#some class", status: "watch", errorClass: "some class" }],
      now
    );
    expect(reds).toHaveLength(0);
    expect(isPlatformSignature("/x#some class")).toBe(false);
  });
});
