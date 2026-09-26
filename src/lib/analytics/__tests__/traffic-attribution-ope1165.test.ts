/**
 * OPE-1165 — outbound clicks carry a GA4-style traffic source, and the
 * conversion rate becomes organic clicks ÷ organic sessions once 21 days of
 * attributed clicks exist ("insufficient data" until then).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import * as schema from "@/lib/db/schema";
import { analyticsEvents } from "@/lib/db/schema";
import { classifyTrafficSource } from "../traffic-attribution";
import {
  ATTRIBUTION_MIN_DAYS,
  insufficientAttributionReason,
  readOrganicConversionClicks,
} from "../organic-conversion-clicks";

const SELF = "meetmeatthefair.com";

describe("classifyTrafficSource — GA4's precedence", () => {
  it.each([
    ["google search", "", "https://www.google.com/", { medium: "organic", source: "google" }],
    ["google.co.uk", "", "https://www.google.co.uk/", { medium: "organic", source: "google" }],
    ["bing", "", "https://www.bing.com/search?q=fair", { medium: "organic", source: "bing" }],
    ["duckduckgo", "", "https://duckduckgo.com/", { medium: "organic", source: "duckduckgo" }],
    [
      "facebook is referral",
      "",
      "https://m.facebook.com/",
      { medium: "referral", source: "m.facebook.com" },
    ],
    [
      "our own site is direct (www or apex)",
      "",
      "https://www.meetmeatthefair.com/events",
      { medium: "(none)", source: "(direct)" },
    ],
    ["no referrer is direct", "", "", { medium: "(none)", source: "(direct)" }],
    [
      "utm beats referrer",
      "?utm_source=Newsletter&utm_medium=Email",
      "https://www.google.com/",
      { medium: "email", source: "newsletter" },
    ],
    ["half a utm pair", "?utm_source=fb", "", { medium: "(not set)", source: "fb" }],
    [
      "gclid is paid, not organic",
      "?gclid=abc",
      "https://www.google.com/",
      { medium: "cpc", source: "google" },
    ],
    [
      "a google-lookalike host is not google",
      "",
      "https://notgoogle.com.evil.example/",
      { medium: "referral", source: "notgoogle.com.evil.example" },
    ],
  ])("%s", (_l, search, referrer, want) => {
    expect(classifyTrafficSource({ search, referrer, selfHost: SELF })).toEqual(want);
  });
});

// ── The numerator, against a real SQLite (json_extract on properties) ────────
let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
const NOW = new Date("2026-10-30T12:00:00Z");
const DAY = 86_400_000;
const WINDOW = {
  since: new Date(NOW.getTime() - 9 * DAY),
  until: new Date(NOW.getTime() - 2 * DAY),
};

beforeEach(() => {
  raw = new Database(":memory:");
  const cfg = getTableConfig(analyticsEvents);
  raw.exec(
    `CREATE TABLE ${cfg.name} (${cfg.columns
      .map((c) => `${c.name} ${c.getSQLType().toUpperCase().includes("INT") ? "INTEGER" : "TEXT"}`)
      .join(", ")})`
  );
  db = drizzle(raw, { schema });
});

let n = 0;
function click(at: Date, medium: string | null, name = "outbound_ticket_click") {
  raw
    .prepare(
      `INSERT INTO analytics_events (id, event_name, event_category, timestamp, properties, source) VALUES (?,?,?,?,?,?)`
    )
    .run(
      `c${++n}`,
      name,
      "conversion",
      Math.floor(at.getTime() / 1000),
      JSON.stringify(medium ? { eventSlug: "x", trafficMedium: medium } : { eventSlug: "x" }),
      "client_beacon"
    );
}
const inWindow = new Date(NOW.getTime() - 5 * DAY);

describe("readOrganicConversionClicks", () => {
  it("no attributed clicks yet → insufficient (the card shows 'not measured', not a number)", async () => {
    click(inWindow, null);
    const r = await readOrganicConversionClicks(db as never, WINDOW, NOW);
    expect(r).toMatchObject({ status: "insufficient", allClicks: 1, firstAttributedAt: null });
    expect(insufficientAttributionReason(r as never)).toMatch(/21 days/);
  });

  it(`attributed for fewer than ${ATTRIBUTION_MIN_DAYS} days → insufficient, naming the switch-over day`, async () => {
    click(new Date(NOW.getTime() - 10 * DAY), "organic");
    click(inWindow, "organic");
    const r = await readOrganicConversionClicks(db as never, WINDOW, NOW);
    expect(r.status).toBe("insufficient");
    expect(insufficientAttributionReason(r as never)).toBe(
      "traffic source recorded on clicks since 2026-10-20; organic ÷ organic from 2026-11-10 (OPE-1165)"
    );
  });

  it("after 21 days → counts ONLY organic clicks (the all-source overcount cannot return)", async () => {
    click(new Date(NOW.getTime() - 30 * DAY), "organic");
    // In the window: 2 organic, and 50 from other sources that used to be counted.
    click(inWindow, "organic");
    click(inWindow, "organic", "outbound_application_click");
    for (let i = 0; i < 25; i++) click(inWindow, "(none)");
    for (let i = 0; i < 25; i++) click(inWindow, "referral");
    const r = await readOrganicConversionClicks(db as never, WINDOW, NOW);
    expect(r).toEqual({ status: "ready", organicClicks: 2, allClicks: 52 });
    // Against 10 organic sessions: 20%, where the old basis read 520%.
    expect((r as { organicClicks: number }).organicClicks / 10).toBeLessThanOrEqual(1);
  });

  it("clicks outside the window and other event names are not counted", async () => {
    click(new Date(NOW.getTime() - 30 * DAY), "organic");
    click(new Date(NOW.getTime() - 1 * DAY), "organic"); // after the window (48h lag)
    click(inWindow, "organic", "blog_outbound_click");
    const r = await readOrganicConversionClicks(db as never, WINDOW, NOW);
    expect(r).toEqual({ status: "ready", organicClicks: 0, allClicks: 0 });
  });
});

// ── The beacon payload carries the attribution ──────────────────────────────
describe("outbound click beacons carry trafficMedium + trafficSource", () => {
  const sent: string[] = [];
  beforeEach(() => {
    sent.length = 0;
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      location: { search: "?utm_source=google&utm_medium=organic", hostname: SELF },
      sessionStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      },
    });
    vi.stubGlobal("document", { referrer: "" });
    // Capture the payload at construction: the test environment's Blob has no
    // .text(), and the beacon only needs the JSON string it was built from.
    vi.stubGlobal(
      "Blob",
      class {
        constructor(public parts: string[]) {}
      }
    );
    vi.stubGlobal("navigator", {
      sendBeacon: (_url: string, blob: { parts: string[] }) => {
        sent.push(blob.parts.join(""));
        return true;
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("ticket and application clicks both include the landing attribution", async () => {
    const { captureLandingAttribution } = await import("../traffic-attribution");
    const { trackOutboundTicketClick, trackOutboundApplicationClick } =
      await import("@/lib/analytics");
    captureLandingAttribution();
    // After an internal navigation the utm params are gone — the stored
    // landing attribution must still be what the click carries.
    (window as unknown as { location: { search: string } }).location.search = "";
    trackOutboundTicketClick("fair-2026", "https://tickets.example/");
    trackOutboundApplicationClick("fair-2026", "https://apply.example/");
    await new Promise((r) => setTimeout(r, 0));
    const props = sent.map((s) => JSON.parse(s).properties);
    expect(props).toHaveLength(2);
    for (const p of props) {
      expect(p).toMatchObject({ trafficMedium: "organic", trafficSource: "google" });
    }
  });
});

// ── Wiring: the badge and the card switch on the same day ────────────────────
import { readFileSync } from "node:fs";
import { join } from "node:path";
describe("both conversion-rate readers go through the organic helper", () => {
  it.each(["src/lib/kpi-states.ts", "src/lib/analytics-overview/conversions.ts"])("%s", (f) => {
    const src = readFileSync(join(process.cwd(), f), "utf8");
    const fn = f.endsWith("kpi-states.ts")
      ? src.slice(src.indexOf("async function readConversionRate("))
      : src.slice(src.indexOf("export async function loadConversionRate("));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toContain("readOrganicConversionClicks(db,");
    // The old all-source count must not be back in the numerator.
    expect(body).not.toMatch(/inArray\(analyticsEvents\.eventName/);
  });
});
