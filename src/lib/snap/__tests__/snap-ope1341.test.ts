/**
 * OPE-1341 — the snap page's two reads: "which fair am I at?" and "what
 * happened to my photo?". Both run against real SQLite with only the columns
 * the queries touch.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/lib/db/schema";
import { findNearbyEvents, runsOn } from "../nearby";
import { describeSnap, loadSnapStatuses } from "../status";

type Db = Parameters<typeof findNearbyEvents>[0];

let raw: InstanceType<typeof Database>;
let db: Db;

const DDL = `
CREATE TABLE venues (id TEXT PRIMARY KEY, name TEXT NOT NULL, latitude REAL, longitude REAL);
CREATE TABLE events (id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL, venue_id TEXT,
  status TEXT NOT NULL, merged_into TEXT, start_date INTEGER, end_date INTEGER);
CREATE TABLE event_days (id TEXT PRIMARY KEY, event_id TEXT NOT NULL, date TEXT NOT NULL);
CREATE TABLE inbound_emails (id TEXT PRIMARY KEY, status TEXT NOT NULL, reply_kind TEXT,
  resulting_event_id TEXT, capture_meta TEXT, error TEXT);
CREATE TABLE admin_actions (id TEXT PRIMARY KEY, action TEXT NOT NULL, target_id TEXT);
`;

const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);
// Brunswick Recreation Center — the OPE-1337 venue.
const BRUNSWICK = { latitude: 43.8937598, longitude: -69.9270216 };

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](DDL);
  db = drizzle(raw, { schema }) as unknown as Db;
  const v = raw.prepare("INSERT INTO venues VALUES (?,?,?,?)");
  v.run("v-brun", "Brunswick Recreation Center", BRUNSWICK.latitude, BRUNSWICK.longitude);
  v.run("v-far", "Portland Expo", 43.6591, -70.2568); // ~20 mi away
  const e = raw.prepare("INSERT INTO events VALUES (?,?,?,?,?,?,?,?)");
  const d = sec("2026-10-08T12:00:00Z");
  e.run(
    "e-expo",
    "people-plus-senior-health-expo",
    "People Plus Senior Health Expo",
    "v-brun",
    "TENTATIVE",
    null,
    d,
    d
  );
  e.run("e-pend", "pending-thing", "Pending Thing", "v-brun", "PENDING", null, d, d);
  e.run("e-merged", "merged-thing", "Merged Thing", "v-brun", "APPROVED", "e-expo", d, d);
  e.run(
    "e-tomorrow",
    "tomorrow-fair",
    "Tomorrow Fair",
    "v-brun",
    "APPROVED",
    null,
    d + 86400,
    d + 86400
  );
  e.run("e-far", "portland-show", "Portland Show", "v-far", "APPROVED", null, d, d);
  raw.prepare("INSERT INTO event_days VALUES (?,?,?)").run("ed1", "e-expo", "2026-10-08");
});

describe("runsOn (OPE-1341)", () => {
  it("uses event_days when present, else the start→end range", () => {
    expect(runsOn("2026-10-08", ["2026-10-08"], null, null)).toBe(true);
    expect(
      runsOn("2026-10-09", ["2026-10-08"], new Date("2026-10-01"), new Date("2026-10-31"))
    ).toBe(false);
    expect(
      runsOn("2026-10-09", [], new Date("2026-10-08T12:00:00Z"), new Date("2026-10-10T12:00:00Z"))
    ).toBe(true);
    expect(
      runsOn("2026-10-11", [], new Date("2026-10-08T12:00:00Z"), new Date("2026-10-10T12:00:00Z"))
    ).toBe(false);
  });
});

describe("findNearbyEvents (OPE-1341)", () => {
  it("offers the TENTATIVE expo at the photo's venue on its day — and nothing non-public, merged, or not running", async () => {
    // The OPE-1337 specimen's GPS: 43°53'37.80"N 69°55'37.34"W.
    const got = await findNearbyEvents(
      db,
      { latitude: 43.893833, longitude: -69.927039 },
      "2026-10-08"
    );
    expect(got.map((g) => g.id)).toEqual(["e-expo"]);
    expect(got[0]).toMatchObject({ atVenue: true, venueName: "Brunswick Recreation Center" });
    expect(got[0].distanceMiles).toBeLessThan(0.05);
  });

  it("returns nothing on a day nothing runs, and nothing for a bad date", async () => {
    expect(await findNearbyEvents(db, BRUNSWICK, "2026-10-07")).toEqual([]);
    expect(await findNearbyEvents(db, BRUNSWICK, "Oct 8")).toEqual([]);
  });
});

describe("snap status (OPE-1341)", () => {
  it("reads the outcome from the row and its decision rows, never inferring one", async () => {
    const ins = raw.prepare("INSERT INTO inbound_emails VALUES (?,?,?,?,?,?)");
    const a = "snap-3f1c2b9e-8d4a-4c6b-9e2f-1a2b3c4d5e6f";
    const b = "snap-11111111-2222-4333-8444-555555555555";
    const c = "snap-22222222-2222-4333-8444-555555555555";
    ins.run(a, "replied", "photo-intake-ack", "e-expo", '{"location_source":"device"}', null);
    ins.run(b, "replied", "photo-intake-unresolved", null, '{"location_source":"none"}', null);
    ins.run(c, "processing", null, null, null, null);
    const act = raw.prepare("INSERT INTO admin_actions VALUES (?,?,?)");
    act.run("x1", "vendor.photo_proposed", a);
    act.run("x2", "photo.gallery_attached", a);
    act.run("x3", "vendor.photo_proposed", "some-other-email");

    const got = await loadSnapStatuses(db, [a, b, c, "not-a-snap-id", "inbound-123"]);
    const byId = Object.fromEntries(got.map((g) => [g.id, g]));
    expect(Object.keys(byId).sort()).toEqual([a, b, c].sort());
    expect(byId[a]).toMatchObject({
      phase: "matched",
      eventName: "People Plus Senior Health Expo",
      outcome: { boothProposals: 1, gallery: 1, boothAutowritten: 0 },
    });
    expect(byId[a].label).toBe("People Plus Senior Health Expo — 1 booth for review, 1 to gallery");
    expect(byId[b]).toMatchObject({ phase: "held" });
    expect(byId[b].label).toContain("no location and no pinned fair");
    expect(byId[c]).toMatchObject({ phase: "processing" });
  });

  it("describeSnap: failed and poster rows say so", () => {
    const base = { id: "snap-x", resultingEventId: null, captureMeta: null, error: null };
    expect(describeSnap({ ...base, status: "failed", replyKind: null }, null).phase).toBe("failed");
    expect(
      describeSnap({ ...base, status: "replied", replyKind: "photo-intake-poster" }, null).phase
    ).toBe("poster");
  });
});

describe("newClientId (OPE-1341)", () => {
  it("is always a v4 UUID the server's snapRowId accepts — idempotency depends on it", async () => {
    const { newClientId } = await import("@/app/admin/snap/snap-queue");
    // Same pattern as mcp-server/src/photo/snap-intake.ts UUID_RE.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const id = newClientId();
      expect(id).toMatch(UUID_RE);
      seen.add(id);
    }
    expect(seen.size).toBe(200);
  });
});
