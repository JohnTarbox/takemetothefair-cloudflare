/**
 * OPE-1582 — one D1 burst, one email. DB-backed (in-memory better-sqlite3) so
 * the real run path is exercised: the 2026-11-08 09:36Z burst is replayed
 * through runScheduledPageErrorCanary and the sends are counted.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../src/schema.js";
import { errorLogs, pageErrorCanaryState } from "../src/schema.js";

const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("../src/db.js", () => ({ getDb: () => h.db }));
vi.mock("../src/logger.js", () => ({ logError: vi.fn(async () => {}) }));

import { __test, runScheduledPageErrorCanary } from "../src/page-error-canary.js";

const { isBurstOpen, planAlerts, renderBurstAlert, BURST_STATE_SOURCE, RED_DEBOUNCE_MINUTES } =
  __test;

const SCHEMA_SQL = `
  CREATE TABLE page_error_canary_state (
    tier TEXT NOT NULL, source TEXT NOT NULL,
    last_alerted_at INTEGER NOT NULL, last_count INTEGER NOT NULL,
    PRIMARY KEY (tier, source)
  );
  CREATE TABLE error_logs (
    id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, level TEXT, error TEXT, message TEXT,
    context TEXT, url TEXT, method TEXT, status_code INTEGER, stack_trace TEXT,
    user_agent TEXT, source TEXT, route TEXT, digest TEXT
  );
`;

const NOW = new Date("2026-11-08T09:40:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const none = new Map<string, Date>();

// Row counts from prod error_logs for the 2026-11-08 09:36Z burst.
const NOV_8_BURST: Array<[string, number]> = [
  ["app/performers/[slug]/page.tsx:getPerformer", 455],
  ["app/vendors/page.tsx:getVendors", 94],
  ["app/promoters/[slug]/page.tsx:getPromoter", 94],
  ["app/vendors/[slug]/page.tsx:getVendor", 77],
  ["app/vendors/page.tsx:getFeaturedVendors", 51],
  ["app/vendors/page.tsx:getVendorTypes", 49],
  ["app/venues/[slug]/page.tsx:getVenue", 27],
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let send: ReturnType<typeof vi.fn>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let env: any;

function seed(
  rows: Array<[string, number]>,
  at: Date,
  message = "Error: Failed query: x\ncause: D1_ERROR: D1 DB is overloaded."
) {
  let i = 0;
  for (const [source, n] of rows) {
    for (let k = 0; k < n; k++) {
      db.insert(errorLogs)
        .values({
          id: `${source}-${at.getTime()}-${i++}`,
          timestamp: at,
          level: "error",
          message,
          source,
        })
        .run();
    }
  }
}

beforeEach(() => {
  const sqlite = new Database(":memory:");
  sqlite.exec(SCHEMA_SQL);
  db = drizzle(sqlite, { schema });
  h.db = db;
  send = vi.fn(async () => {});
  env = { DB: {}, ALERT_EMAIL_TECHNICAL: "alerts@example.com", EMAIL_JOBS: { send } };
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  return () => {
    vi.useRealTimers();
  };
});

describe("runScheduledPageErrorCanary — burst replay (OPE-1582)", () => {
  it("sends exactly one email for the Nov 8 burst, naming all 7 loaders", async () => {
    seed(NOV_8_BURST, minutesAgo(4));
    await runScheduledPageErrorCanary(env);

    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0][0];
    expect(msg.subject).toBe("🔴 D1 burst: 847 errors across 7 loaders (10m)");
    for (const [source] of NOV_8_BURST) expect(msg.text).toContain(source);
  });

  it("still records every source (and the burst) in the state table", async () => {
    seed(NOV_8_BURST, minutesAgo(4));
    await runScheduledPageErrorCanary(env);

    const rows = await db.select().from(pageErrorCanaryState);
    expect(rows.map((r: { source: string }) => r.source).sort()).toEqual(
      [...NOV_8_BURST.map(([s]) => s), BURST_STATE_SOURCE].sort()
    );
  });

  it("does not send again on the next tick while the burst alert is open", async () => {
    seed(NOV_8_BURST, minutesAgo(4));
    await runScheduledPageErrorCanary(env);
    expect(send).toHaveBeenCalledTimes(1);

    // A loader that was not in the first alert goes RED ten minutes later.
    vi.setSystemTime(new Date(NOW.getTime() + 10 * 60_000));
    seed([["app/events/page.tsx:getEvents", 40]], new Date(NOW.getTime() + 8 * 60_000));
    await runScheduledPageErrorCanary(env);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("alerts again once the burst alert has aged out", async () => {
    seed(NOV_8_BURST, minutesAgo(4));
    await runScheduledPageErrorCanary(env);

    const later = new Date(NOW.getTime() + (RED_DEBOUNCE_MINUTES + 5) * 60_000);
    vi.setSystemTime(later);
    seed(NOV_8_BURST, new Date(later.getTime() - 60_000));
    await runScheduledPageErrorCanary(env);

    expect(send).toHaveBeenCalledTimes(2);
  });

  it("keeps the per-function email when only one source fires", async () => {
    seed([["app/events/page.tsx:getEvents", 12]], minutesAgo(4));
    await runScheduledPageErrorCanary(env);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].subject).toBe(
      "🔴 Page-error canary RED: app/events/page.tsx:getEvents (12 in 10m)"
    );
  });

  it("does not call a non-D1 burst a D1 burst", async () => {
    seed(NOV_8_BURST.slice(0, 2), minutesAgo(4), "TypeError: x is not a function");
    await runScheduledPageErrorCanary(env);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].subject).toBe(
      "🔴 Page-error burst: 549 errors across 2 loaders (10m)"
    );
  });
});

describe("planAlerts (OPE-1582)", () => {
  const a = { source: "app/a/page.tsx:a", count: 50 };
  const b = { source: "app/b/page.tsx:b", count: 50 };

  it("one firing source is a single alert, two are a burst", () => {
    expect(planAlerts([a], none, NOW).kind).toBe("single");
    expect(planAlerts([a, b], none, NOW).kind).toBe("burst");
  });

  it("a source inside its own debounce does not count toward a burst", () => {
    const m = new Map([[`RED::${a.source}`, minutesAgo(5)]]);
    const plan = planAlerts([a, b], m, NOW);
    expect(plan.kind).toBe("single");
    expect(plan.debounced).toBe(1);
  });

  it("nothing firing is 'none'", () => {
    const m = new Map([
      [`RED::${a.source}`, minutesAgo(5)],
      [`RED::${b.source}`, minutesAgo(5)],
    ]);
    expect(planAlerts([a, b], m, NOW).kind).toBe("none");
  });

  it("an open RED burst suppresses both a single and a burst", () => {
    const m = new Map([[`RED::${BURST_STATE_SOURCE}`, minutesAgo(5)]]);
    expect(planAlerts([a], m, NOW).kind).toBe("suppressed-by-open-burst");
    expect(planAlerts([a, b], m, NOW).kind).toBe("suppressed-by-open-burst");
  });
});

describe("isBurstOpen (OPE-1582)", () => {
  it("RED burst covers RED and YELLOW inside 30 min, nothing after", () => {
    expect(isBurstOpen("RED", minutesAgo(29), null, NOW)).toBe(true);
    expect(isBurstOpen("YELLOW", minutesAgo(29), null, NOW)).toBe(true);
    expect(isBurstOpen("RED", minutesAgo(31), null, NOW)).toBe(false);
  });

  it("a YELLOW burst does not mute a RED escalation", () => {
    expect(isBurstOpen("RED", null, minutesAgo(5), NOW)).toBe(false);
    expect(isBurstOpen("YELLOW", null, minutesAgo(5), NOW)).toBe(true);
    expect(isBurstOpen("YELLOW", null, minutesAgo(61), NOW)).toBe(false);
  });

  it("no burst row means not open", () => {
    expect(isBurstOpen("RED", null, null, NOW)).toBe(false);
  });
});

describe("renderBurstAlert (OPE-1582)", () => {
  it("names the sources below the alert threshold when there are some", () => {
    const { textBody } = renderBurstAlert(
      "RED",
      [{ source: "app/a/page.tsx:a", count: 20, tier: "RED" }],
      true,
      25
    );
    expect(textBody).toContain("+5 more");
  });
});
