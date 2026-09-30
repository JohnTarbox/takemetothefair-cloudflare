/**
 * OPE-1161 — analytics cards whose number contradicted their label (batch 1:
 * A1, A3, E14, E15, E16, E17). Each case asserts the NEW behaviour, so it fails
 * on the old code.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as schema from "../../db/schema";
import type { Db } from "../shared";

vi.mock("@/lib/bing-webmaster", async (orig) => ({
  ...(await orig<typeof import("@/lib/bing-webmaster")>()),
  getIndexNowQuota: vi.fn(async () => ({ dailyRemaining: 100, monthlyRemaining: 1000 })),
}));

import { loadIndexNow, loadRecentErrors } from "../health";
import { loadActionQueueWithSuppressed } from "../activity";
import { bingActionInputsUnmeasured } from "../bing-tiles";
import { readIndexNowPauseForDisplay } from "@/lib/indexnow-breaker";
import { classifyQueueDrain, type QueueFlow } from "@/lib/queue-freeze";
import type { KpiName } from "@/lib/kpi-thresholds";
import type { KpiStateRow } from "@/lib/kpi-states";

const SCHEMA_SQL = `
  CREATE TABLE error_logs (
    id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, level TEXT, message TEXT,
    context TEXT, url TEXT, method TEXT, status_code INTEGER, stack_trace TEXT,
    user_agent TEXT, source TEXT, route TEXT, digest TEXT
  );
  CREATE TABLE indexnow_submissions (
    id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, source TEXT, url_count INTEGER,
    urls TEXT, status TEXT, http_status INTEGER, error TEXT
  );
  CREATE TABLE kpi_state_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kpi_name TEXT NOT NULL, computed_at INTEGER NOT NULL,
    value REAL, state TEXT, state_changed_from_previous INTEGER NOT NULL DEFAULT 0,
    first_detected_at INTEGER, meta TEXT
  );
  CREATE TABLE recommendation_rules (
    id TEXT PRIMARY KEY, rule_key TEXT, title TEXT, rationale_template TEXT, severity TEXT,
    category TEXT, enabled INTEGER, created_at INTEGER, total_match_count INTEGER
  );
`;

let db: Db;
let raw: Database.Database;
const now = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema }) as unknown as Db;
});

describe("A1 — Errors (last 24h) counts ERROR rows only", () => {
  it("info and warn rows are not errors", async () => {
    const ins = raw.prepare(
      "INSERT INTO error_logs (id, timestamp, level, source) VALUES (?, ?, ?, ?)"
    );
    ins.run("e1", now(), "error", "api/a");
    ins.run("e2", now(), "error", "api/a");
    ins.run("i1", now(), "info", "recs-scan");
    ins.run("i2", now(), "info", "recs-scan");
    ins.run("w1", now(), "warn", "indexnow");
    const card = await loadRecentErrors(db, new Date(Date.now() - 86400_000));
    expect(card.last24hCount).toBe(2);
    expect(card.topSources).toEqual([{ source: "api/a", count: 2 }]);
  });
});

describe("A3 — IndexNow today: sent to Bing, and the pause READ from KV", () => {
  function seed(statuses: string[]) {
    const ins = raw.prepare(
      "INSERT INTO indexnow_submissions (id, timestamp, status) VALUES (?, ?, ?)"
    );
    statuses.forEach((st, i) => ins.run(`s${i}`, now(), st));
  }
  const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");

  it("breaker-skipped rows are not 'sent'", async () => {
    seed(["skipped", "skipped", "skipped"]);
    const card = await loadIndexNow(db, {} as never, today, {
      paused: true,
      note: "ratified 2026-08-16",
      readOk: true,
    });
    expect(card.todayAttempts).toBe(0);
    expect(card.todayDeferred).toBe(3);
    expect(card.pause).toEqual({ state: "paused", note: "ratified 2026-08-16" });
  });

  it("an unread pause state is 'unknown', never 'active'", async () => {
    seed(["success"]);
    const card = await loadIndexNow(db, {} as never, today, {
      paused: false,
      note: null,
      readOk: false,
    });
    expect(card.todayAttempts).toBe(1);
    expect(card.pause.state).toBe("unknown");
  });
});

describe("E15 — the display pause reader does not fail open", () => {
  it("a throwing KV read is not 'not paused'", async () => {
    const kv = {
      get: async () => {
        throw new Error("KV down");
      },
    };
    expect(await readIndexNowPauseForDisplay(kv as never)).toEqual({
      paused: false,
      note: null,
      readOk: false,
    });
    expect((await readIndexNowPauseForDisplay(null)).readOk).toBe(false);
    expect(await readIndexNowPauseForDisplay({ get: async () => "note" } as never)).toEqual({
      paused: true,
      note: "note",
      readOk: true,
    });
  });

  it("the Bing chip's kvAvailable requires a successful read", () => {
    const page = readFileSync(join(process.cwd(), "src/app/admin/analytics/page.tsx"), "utf8");
    expect(page).toContain("kvAvailable: kv !== null && pause.readOk,");
    expect(page).toContain("readIndexNowPauseForDisplay(kv),");
  });
});

describe("E14 — Bing action items: an unread input is not 'healthy'", () => {
  it("names every input it could not measure", () => {
    expect(
      bingActionInputsUnmeasured(["crawl", "sitemaps"], {
        kvAvailable: false,
        countsAvailable: true,
      })
    ).toEqual([
      "crawl report (crawl errors, coverage)",
      "sitemap feeds (duplicates, coverage)",
      "IndexNow pause/cooldown state",
    ]);
    expect(bingActionInputsUnmeasured([], { kvAvailable: true, countsAvailable: true })).toEqual(
      []
    );
  });

  it("the ✓ is reached only when nothing is unmeasured", () => {
    const page = readFileSync(join(process.cwd(), "src/app/admin/analytics/page.tsx"), "utf8");
    const healthy = page.indexOf("No action items — healthy ✓");
    const guard = page.lastIndexOf(
      "actionItems.length === 0 && actionInputsUnmeasured.length > 0",
      healthy
    );
    expect(guard).toBeGreaterThan(-1);
    expect(healthy - guard).toBeLessThan(600);
  });
});

describe("E16 — the action queue says what it suppressed", () => {
  it("a YELLOW KPI that was RED this week is reported, not hidden", async () => {
    raw
      .prepare("INSERT INTO kpi_state_history (kpi_name, computed_at, state) VALUES (?, ?, ?)")
      .run("site_ctr", now() - 3600, "RED");
    const row = (kpi: KpiName, state: string): KpiStateRow =>
      ({
        id: 1,
        kpiName: kpi,
        computedAt: new Date(),
        value: 1,
        state,
        stateChangedFromPrevious: false,
        firstDetectedAt: null,
        meta: null,
      }) as unknown as KpiStateRow;
    const states = new Map<KpiName, KpiStateRow>([["site_ctr", row("site_ctr", "YELLOW")]]);
    const { entries, suppressed } = await loadActionQueueWithSuppressed(db, states);
    expect(entries).toEqual([]);
    expect(suppressed).toEqual(["site_ctr"]);
  });
});

describe("E17 — Queue drain: FROZEN vs SLOW, on the alert's thresholds", () => {
  const base: QueueFlow = {
    queueName: "q",
    label: "Q",
    href: "#",
    depth: 20,
    inflow7d: 10,
    outflow7d: 0,
    inflow14d: 20,
    outflow14d: 0,
    oldestOpenAgeHours: 48,
  };
  const t = new Date();

  it("zero outflow is frozen; closing too slowly is slow", () => {
    expect(classifyQueueDrain(base, t)).toBe("frozen");
    expect(classifyQueueDrain({ ...base, outflow7d: 2, outflow14d: 4 }, t)).toBe("slow");
    expect(classifyQueueDrain({ ...base, outflow7d: 10, outflow14d: 20 }, t)).toBeNull();
  });

  it("an override moves the slow line, as it does for the daily alert", () => {
    const flow = { ...base, outflow7d: 5, outflow14d: 8 }; // ratio 0.4
    expect(classifyQueueDrain(flow, t)).toBe("slow"); // default 0.5
    expect(classifyQueueDrain(flow, t, { slowDrainRatio: 0.3 })).toBeNull();
  });

  it("the tile loads the alert's thresholds", () => {
    const src = readFileSync(
      join(process.cwd(), "src/lib/analytics-overview/queue-drain.ts"),
      "utf8"
    );
    expect(src).toContain("loadQueueFreezeThresholds(db),");
    expect(src).toContain("drainState: classifyQueueDrain(f, now, thresholds),");
  });
});
