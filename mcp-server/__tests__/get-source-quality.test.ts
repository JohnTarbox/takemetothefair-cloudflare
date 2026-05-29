/**
 * Unit tests for the get_source_quality MCP tool (F1, analyst 2026-05-29).
 *
 * The tool runs the same query /admin/source-quality renders. Tests cover
 * the meaningful query behaviors: min_events threshold, ingestion_method
 * filter, sort variants, and drift-row merge.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { events, promoters, eventDateDriftFindings } from "../src/schema.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "test-key" };

let db: TestDb;
let server: CapturingMcpServer;

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, ADMIN_AUTH, ENV as never);
  db.insert(promoters)
    .values({ id: "p1", companyName: "Test Promoter", slug: "test-promoter" })
    .run();
});

// Helpers ------------------------------------------------------------------

interface EventOverrides {
  id: string;
  slug: string;
  sourceDomain: string;
  ingestionMethod: string;
  status?: string;
  gateFlags?: string | null;
  imageUrl?: string | null;
}

function seedEvent(o: EventOverrides) {
  db.insert(events)
    .values({
      id: o.id,
      name: `Event ${o.id}`,
      slug: o.slug,
      promoterId: "p1",
      status: (o.status ?? "APPROVED") as never,
      sourceDomain: o.sourceDomain,
      ingestionMethod: o.ingestionMethod,
      gateFlags: o.gateFlags ?? null,
      imageUrl: o.imageUrl ?? null,
    })
    .run();
}

function seedDrift(eventId: string, days: number, resolved = false) {
  db.insert(eventDateDriftFindings)
    .values({
      id: `drift-${eventId}-${days}`,
      eventId,
      storedStartDate: new Date("2026-05-01"),
      driftDays: days,
      checkedAt: new Date("2026-05-15"),
      resolvedAt: resolved ? new Date("2026-05-20") : null,
    })
    .run();
}

async function invoke(args: Record<string, unknown> = {}) {
  const result = (await server.invoke("get_source_quality", args)) as {
    content: Array<{ text: string }>;
  };
  return JSON.parse(result.content[0].text) as {
    overall: { total_events: number; sources_tracked: number; classified_pct: number };
    filters: { min_events: number; ingestion_method: string | null; sort: string };
    row_count: number;
    rows: Array<{
      source_domain: string | null;
      ingestion_method: string | null;
      total: number;
      rejected: number;
      cancelled: number;
      gate_flagged: number;
      imageless: number;
      unresolved_drift: number;
      concern_pct: number;
    }>;
  };
}

// Tests -------------------------------------------------------------------

describe("get_source_quality", () => {
  it("returns zero rows when no events have ingestion_method set", async () => {
    const result = await invoke();
    expect(result.row_count).toBe(0);
    expect(result.rows).toEqual([]);
    expect(result.overall.total_events).toBe(0);
  });

  it("filters out sources below min_events", async () => {
    // bigsource: 5 events; small: 2 events. With default min_events=3,
    // only bigsource survives.
    for (let i = 0; i < 5; i++) {
      seedEvent({
        id: `b${i}`,
        slug: `big-${i}`,
        sourceDomain: "bigsource.com",
        ingestionMethod: "direct_scrape",
      });
    }
    for (let i = 0; i < 2; i++) {
      seedEvent({
        id: `s${i}`,
        slug: `small-${i}`,
        sourceDomain: "smallsource.com",
        ingestionMethod: "direct_scrape",
      });
    }
    const result = await invoke();
    expect(result.row_count).toBe(1);
    expect(result.rows[0].source_domain).toBe("bigsource.com");
    expect(result.rows[0].total).toBe(5);

    // Lower min_events to 1 — both visible.
    const all = await invoke({ min_events: 1 });
    expect(all.row_count).toBe(2);
  });

  it("computes concern_pct from rejected + cancelled + gate_flagged + unresolved_drift", async () => {
    // 10 events. 1 REJECTED, 1 CANCELLED, 1 PENDING with gate_flags,
    // 1 with one unresolved drift finding, 1 with one resolved drift
    // (must NOT count), 5 healthy APPROVED.
    seedEvent({
      id: "e1",
      slug: "e1",
      sourceDomain: "src.com",
      ingestionMethod: "direct_scrape",
      status: "REJECTED",
    });
    seedEvent({
      id: "e2",
      slug: "e2",
      sourceDomain: "src.com",
      ingestionMethod: "direct_scrape",
      status: "CANCELLED",
    });
    seedEvent({
      id: "e3",
      slug: "e3",
      sourceDomain: "src.com",
      ingestionMethod: "direct_scrape",
      status: "PENDING",
      gateFlags: '["duration_too_long_for_scale"]',
    });
    seedEvent({
      id: "e4",
      slug: "e4",
      sourceDomain: "src.com",
      ingestionMethod: "direct_scrape",
    });
    seedDrift("e4", 7);
    seedEvent({
      id: "e5",
      slug: "e5",
      sourceDomain: "src.com",
      ingestionMethod: "direct_scrape",
    });
    seedDrift("e5", 7, /* resolved */ true);
    for (let i = 6; i <= 10; i++) {
      seedEvent({
        id: `e${i}`,
        slug: `e${i}`,
        sourceDomain: "src.com",
        ingestionMethod: "direct_scrape",
      });
    }

    const result = await invoke();
    expect(result.row_count).toBe(1);
    const r = result.rows[0];
    expect(r.total).toBe(10);
    expect(r.rejected).toBe(1);
    expect(r.cancelled).toBe(1);
    expect(r.gate_flagged).toBe(1);
    expect(r.unresolved_drift).toBe(1); // resolved drift not counted
    // concern = (1 + 1 + 1 + 1) / 10 = 40.0%
    expect(r.concern_pct).toBe(40.0);
  });

  it("counts imageless when image_url is NULL or empty string", async () => {
    seedEvent({
      id: "i1",
      slug: "i1",
      sourceDomain: "src.com",
      ingestionMethod: "direct_scrape",
      imageUrl: null,
    });
    seedEvent({
      id: "i2",
      slug: "i2",
      sourceDomain: "src.com",
      ingestionMethod: "direct_scrape",
      imageUrl: "",
    });
    seedEvent({
      id: "i3",
      slug: "i3",
      sourceDomain: "src.com",
      ingestionMethod: "direct_scrape",
      imageUrl: "https://cdn.example/x.jpg",
    });
    const result = await invoke();
    expect(result.rows[0].imageless).toBe(2);
  });

  it("filters by ingestion_method", async () => {
    for (let i = 0; i < 3; i++) {
      seedEvent({
        id: `d${i}`,
        slug: `d${i}`,
        sourceDomain: "src.com",
        ingestionMethod: "direct_scrape",
      });
    }
    for (let i = 0; i < 3; i++) {
      seedEvent({
        id: `e${i}`,
        slug: `e${i}`,
        sourceDomain: "src.com",
        ingestionMethod: "email_submission",
      });
    }
    const only = await invoke({ ingestion_method: "email_submission" });
    expect(only.row_count).toBe(1);
    expect(only.rows[0].ingestion_method).toBe("email_submission");
    expect(only.rows[0].total).toBe(3);
  });

  it("sorts by total_desc when requested", async () => {
    // Smaller source has higher concern (1 REJECTED of 3); larger has
    // none. concern_desc would put smaller first; total_desc flips.
    seedEvent({
      id: "s1",
      slug: "s1",
      sourceDomain: "small.com",
      ingestionMethod: "direct_scrape",
      status: "REJECTED",
    });
    for (let i = 0; i < 2; i++) {
      seedEvent({
        id: `s${i + 2}`,
        slug: `s${i + 2}`,
        sourceDomain: "small.com",
        ingestionMethod: "direct_scrape",
      });
    }
    for (let i = 0; i < 10; i++) {
      seedEvent({
        id: `b${i}`,
        slug: `b${i}`,
        sourceDomain: "big.com",
        ingestionMethod: "direct_scrape",
      });
    }
    const concern = await invoke({ sort: "concern_desc" });
    expect(concern.rows[0].source_domain).toBe("small.com");
    const total = await invoke({ sort: "total_desc" });
    expect(total.rows[0].source_domain).toBe("big.com");
  });

  it("populates the overall rollup independent of filters", async () => {
    // 5 classified + 2 unclassified; sources_tracked counts DISTINCT
    // source_domain (NULL excluded).
    for (let i = 0; i < 5; i++) {
      seedEvent({
        id: `c${i}`,
        slug: `c${i}`,
        sourceDomain: "src.com",
        ingestionMethod: "direct_scrape",
      });
    }
    db.insert(events)
      .values([
        { id: "u1", name: "U1", slug: "u1", promoterId: "p1", status: "APPROVED" },
        { id: "u2", name: "U2", slug: "u2", promoterId: "p1", status: "APPROVED" },
      ])
      .run();
    const result = await invoke();
    expect(result.overall.total_events).toBe(7);
    expect(result.overall.sources_tracked).toBe(1);
    // 5 classified / 7 total = 71.4%
    expect(result.overall.classified_pct).toBeCloseTo(71.4, 1);
  });
});
