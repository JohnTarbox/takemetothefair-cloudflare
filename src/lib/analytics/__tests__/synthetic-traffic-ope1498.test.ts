/**
 * OPE-1498 — synthetic traffic is tagged on write and excluded on read.
 *
 * Three layers, each against the real thing where it matters:
 *  1. classifySynthetic — the UA strings are the ones observed in prod Workers
 *     Logs (Lightpanda, meta-externalagent, a real Edge visitor), plus the
 *     false-positive trap the pattern was tightened for (an Android CUBOT).
 *  2. notSynthetic — run on real SQLite over real JSON, because a predicate
 *     that matched nothing would also "exclude the canary" in a mocked test.
 *  3. The beacon route — the mark is merged server-side and a client can
 *     neither forge it nor clear it.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sql } from "drizzle-orm";
import * as schema from "../../db/schema";
import { analyticsEvents } from "../../db/schema";
import {
  classifySynthetic,
  notSynthetic,
  SYNTHETIC_COOKIE,
  SYNTHETIC_SOURCES,
} from "../synthetic-traffic";

const UA = {
  lightpanda: "Lightpanda/1.0",
  metaAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 (compatible; meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler))",
  googlebot: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  cubot:
    "Mozilla/5.0 (Linux; Android 9; CUBOT P30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
};

describe("classifySynthetic", () => {
  it("marks the canary by its cookie, whatever its UA says", () => {
    expect(classifySynthetic(`a=1; ${SYNTHETIC_COOKIE}=funnel-canary; b=2`, UA.iphone)).toEqual({
      synthetic: true,
      synthetic_source: SYNTHETIC_SOURCES.funnelCanary,
    });
  });

  it("does not echo a junk cookie value into the row", () => {
    expect(classifySynthetic(`${SYNTHETIC_COOKIE}=<script>`, UA.edge)?.synthetic_source).toBe(
      "cookie"
    );
  });

  it.each([
    [UA.lightpanda, "ua:lightpanda"],
    [UA.metaAgent, "ua:externalagent"],
    [UA.googlebot, "ua:googlebot"],
  ])("marks self-declared automation %#", (ua, source) => {
    expect(classifySynthetic(null, ua)).toEqual({ synthetic: true, synthetic_source: source });
  });

  it.each([UA.edge, UA.iphone, UA.cubot, "", null])("leaves a visitor unmarked %#", (ua) => {
    expect(classifySynthetic("_ga=GA1.1.1.2", ua)).toBeNull();
  });
});

describe("notSynthetic on real SQLite", () => {
  it("excludes exactly the marked rows", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`CREATE TABLE analytics_events (
      id TEXT PRIMARY KEY, event_name TEXT NOT NULL, event_category TEXT NOT NULL,
      timestamp INTEGER NOT NULL, properties TEXT DEFAULT '{}', user_id TEXT, source TEXT)`);
    const rows: Array<[string, string]> = [
      ["visitor-legacy", "{}"],
      ["visitor", JSON.stringify({ device: "mobile", os: "ios" })],
      ["canary", JSON.stringify({ device: "mobile", synthetic: true, synthetic_source: "x" })],
      ["bot", JSON.stringify({ device: "unknown", synthetic: true, synthetic_source: "ua:y" })],
    ];
    const ins = sqlite.prepare(
      "INSERT INTO analytics_events VALUES (?, 'submit_view', 'funnel', 1, ?, NULL, 'client_beacon')"
    );
    for (const [id, props] of rows) ins.run(id, props);
    const db = drizzle(sqlite, { schema });

    const all = db.select({ id: analyticsEvents.id }).from(analyticsEvents).all();
    const kept = db
      .select({ id: analyticsEvents.id })
      .from(analyticsEvents)
      .where(notSynthetic(analyticsEvents.properties))
      .orderBy(sql`id`)
      .all();

    // Landmark: four rows exist, so "two kept" is a filter, not an empty table.
    expect(all).toHaveLength(4);
    expect(kept.map((r) => r.id)).toEqual(["visitor", "visitor-legacy"]);
  });
});

// ── The beacon route ────────────────────────────────────────────────────────
const tracked = vi.hoisted(() => [] as Array<{ properties?: Record<string, unknown> }>);
vi.mock("@/lib/server-analytics", () => ({
  trackServerEvent: vi.fn(async (_db: unknown, opts: { properties?: Record<string, unknown> }) => {
    tracked.push(opts);
  }),
}));
vi.mock("@/lib/cloudflare", () => ({ getCloudflareDb: vi.fn(() => ({})) }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  rateLimitResponse: vi.fn(),
}));

import { POST } from "../../../app/api/analytics/track/route";

function beacon(properties: Record<string, unknown>, headers: Record<string, string>) {
  return new Request("http://localhost:3000/api/analytics/track", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ name: "submit_view", category: "funnel", properties }),
  });
}

describe("POST /api/analytics/track — synthetic mark", () => {
  beforeEach(() => {
    tracked.length = 0;
  });

  it("tags a canary request server-side", async () => {
    const res = await POST(
      beacon({}, { cookie: `${SYNTHETIC_COOKIE}=funnel-canary`, "user-agent": UA.iphone })
    );
    expect(res.status).toBe(204);
    expect(tracked[0]?.properties).toEqual({
      device: "mobile",
      os: "ios",
      synthetic: true,
      synthetic_source: "funnel-canary",
    });
  });

  it("strips a visitor's self-supplied mark — the server alone decides", async () => {
    await POST(
      beacon({ synthetic: true, synthetic_source: "spoof", a: 1 }, { "user-agent": UA.edge })
    );
    expect(tracked[0]?.properties).toEqual({ a: 1, device: "desktop", os: "windows" });
  });

  it("a client cannot clear the mark on a synthetic request", async () => {
    await POST(beacon({ synthetic: false }, { "user-agent": UA.lightpanda }));
    expect(tracked[0]?.properties).toMatchObject({
      synthetic: true,
      synthetic_source: "ua:lightpanda",
    });
  });
});
