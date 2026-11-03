/**
 * OPE-1549 — the Snap app never sent a location or an event pin.
 *
 * Root cause: the site-wide `Permissions-Policy: geolocation=()` disabled the
 * Geolocation API on every page, so `watchPosition` failed at once — and the
 * "Pick the fair" list only ever held the GPS-nearby results, so with no fix it
 * offered nothing to pin. These tests cover the location-free day list, the
 * always-visible status line, and a guard on both header sources.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/lib/db/schema";
import { findEventsOnDate } from "../nearby";
import { locationLine } from "../location-status";

type Db = Parameters<typeof findEventsOnDate>[0];
let raw: InstanceType<typeof Database>;
let db: Db;

const DDL = `
CREATE TABLE venues (id TEXT PRIMARY KEY, name TEXT NOT NULL, city TEXT, state TEXT,
  latitude REAL, longitude REAL);
CREATE TABLE events (id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL, venue_id TEXT,
  status TEXT NOT NULL, merged_into TEXT, start_date INTEGER, end_date INTEGER);
CREATE TABLE event_days (id TEXT PRIMARY KEY, event_id TEXT NOT NULL, date TEXT NOT NULL);
`;
const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](DDL);
  db = drizzle(raw, { schema }) as unknown as Db;
  const v = raw.prepare("INSERT INTO venues VALUES (?,?,?,?,?,?)");
  // No coordinates on purpose: the day list must not depend on geocoding either.
  v.run("v-armory", "Augusta Armory", "Augusta", "ME", null, null);
  v.run("v-expo", "Portland Expo", "Portland", "ME", 43.6591, -70.2568);
  const e = raw.prepare("INSERT INTO events VALUES (?,?,?,?,?,?,?,?)");
  const d = sec("2026-11-01T13:00:00Z");
  e.run(
    "e-harvest",
    "harvest-festival-of-crafts-2026",
    "Harvest Festival of Crafts 2026",
    "v-armory",
    "APPROVED",
    null,
    sec("2026-10-31T13:00:00Z"),
    d
  );
  e.run("e-bazaar", "a-bazaar", "A Holiday Bazaar", "v-expo", "TENTATIVE", null, d, d);
  e.run("e-novenue", "no-venue-sale", "No Venue Sale", null, "APPROVED", null, d, d);
  e.run("e-pend", "pending", "Pending Thing", "v-armory", "PENDING", null, d, d);
  e.run("e-merged", "merged", "Merged Thing", "v-armory", "APPROVED", "e-harvest", d, d);
  e.run("e-days", "day-rows", "Day Rows Fair", "v-expo", "APPROVED", null, d, d);
  // event_days win over the range: this one does NOT run on 11-01.
  raw.prepare("INSERT INTO event_days VALUES (?,?,?)").run("ed1", "e-days", "2026-11-02");
});

describe("findEventsOnDate (OPE-1549)", () => {
  it("lists every public event running that day, alphabetical, with no location at all", async () => {
    const got = await findEventsOnDate(db, "2026-11-01");
    expect(got.map((g) => g.id)).toEqual(["e-bazaar", "e-harvest", "e-novenue"]);
    expect(got.find((g) => g.id === "e-harvest")).toMatchObject({
      slug: "harvest-festival-of-crafts-2026",
      venueName: "Augusta Armory · Augusta, ME",
      distanceMiles: null,
      atVenue: false,
    });
    expect(got.find((g) => g.id === "e-novenue")?.venueName).toBe("Venue not set");
  });

  it("covers a multi-day event's later day, and returns nothing for a bad date", async () => {
    expect((await findEventsOnDate(db, "2026-10-31")).map((g) => g.id)).toEqual(["e-harvest"]);
    expect(await findEventsOnDate(db, "Nov 1")).toEqual([]);
  });
});

describe("locationLine (OPE-1549) — the on-screen status, every state", () => {
  it("pending", () => {
    expect(locationLine({ geo: "pending", accuracyM: null, atEventName: null }).text).toBe(
      "Locating…"
    );
  });
  it("located at an event, with accuracy", () => {
    const l = locationLine({ geo: "ok", accuracyM: 18.6, atEventName: "Harvest Festival" });
    expect(l).toEqual({
      text: "You're at: Harvest Festival (±19 m)",
      tone: "good",
      action: "none",
    });
  });
  it("located, but no event here: offers the picker", () => {
    const l = locationLine({ geo: "ok", accuracyM: 40, atEventName: null });
    expect(l.text).toContain("pick the fair");
    expect(l.action).toBe("pick");
  });
  it("blocked: tap to fix", () => {
    expect(locationLine({ geo: "denied", accuracyM: null, atEventName: null })).toEqual({
      text: "Location blocked: tap to fix",
      tone: "bad",
      action: "retry",
    });
  });
  it("no fix: pick the fair", () => {
    expect(locationLine({ geo: "unavailable", accuracyM: null, atEventName: null })).toEqual({
      text: "No fix: pick the fair",
      tone: "warn",
      action: "pick",
    });
  });
});

describe("Permissions-Policy allows same-origin geolocation (OPE-1549 root cause)", () => {
  const root = process.cwd();
  const sources = {
    "next.config.mjs": readFileSync(join(root, "next.config.mjs"), "utf8"),
    "public/_headers": readFileSync(join(root, "public", "_headers"), "utf8"),
  };
  for (const [name, text] of Object.entries(sources)) {
    it(`${name} never sends geolocation=() and does send geolocation=(self)`, () => {
      // Positive landmark: the header is still present in this source, so a
      // removed or renamed header can't pass by matching nothing.
      expect(text).toMatch(/Permissions-Policy/);
      expect(text).not.toMatch(/geolocation=\(\s*\)/);
      expect(text).toMatch(/geolocation=\(self\)/);
    });
  }
});
