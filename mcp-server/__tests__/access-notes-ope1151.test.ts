/**
 * OPE-1151 — `events.access_notes` now renders publicly on every event, so:
 *
 *  1. the data move (drizzle/0367) must leave ZERO analyst prose in the column,
 *     move every byte it removes into `event_internal_notes`, and be a no-op on
 *     a re-run and on an empty DB (docs/bulk-mutation-discipline.md);
 *  2. `update_event` must refuse prose-shaped access_notes, and carry private
 *     notes in `internal_notes` (readable through get_event_details_admin);
 *  3. nothing on a PUBLIC MCP path may read the private table.
 *
 * The fixture is every non-empty access_notes row in prod on 2026-10-15 (65),
 * classified by eye; its texts were checked against prod by id + length.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { registerAdminEventReadTools } from "../src/tools/admin-event-read.js";
import { events, users, promoters, eventInternalNotes } from "../src/schema.js";
import { accessNotesProseReason } from "../src/access-notes-guard.js";

const ROOT = join(__dirname, "../..");
const MIGRATION = readFileSync(join(ROOT, "drizzle/0367_ope1151_event_internal_notes.sql"), "utf8");
type Row = {
  id: string;
  slug: string;
  class: "visitor" | "prose" | "mixed";
  before: string;
  after: string | null;
};
const FIXTURE: Row[] = JSON.parse(
  readFileSync(
    join(ROOT, "src/lib/events/__tests__/fixtures/ope1151-access-notes-2026-10-15.json"),
    "utf8"
  )
);
const PREFIX =
  "[OPE-1151 2026-10-15: moved verbatim from access_notes, which now renders publicly] ";

describe("fixture shape (landmarks, so the absences below mean something)", () => {
  it("is the 65 prod rows: 56 visitor, 6 prose, 3 mixed", () => {
    expect(FIXTURE).toHaveLength(65);
    const count = (c: string) => FIXTURE.filter((r) => r.class === c).length;
    expect([count("visitor"), count("prose"), count("mixed")]).toEqual([56, 6, 3]);
  });
});

describe("accessNotesProseReason", () => {
  it("flags every row that was moved", () => {
    for (const r of FIXTURE.filter((r) => r.class !== "visitor")) {
      expect(accessNotesProseReason(r.before), r.slug).not.toBeNull();
    }
  });
  it("passes every visitor row and every trimmed mixed row", () => {
    for (const r of FIXTURE) {
      if (r.after === null) continue;
      expect(accessNotesProseReason(r.after), r.slug).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// The migration, run against a copy of the classified prod rows.
// ---------------------------------------------------------------------------
function freshDb(seed: boolean) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db["exec"](`CREATE TABLE events (id TEXT PRIMARY KEY, slug TEXT, access_notes TEXT);`);
  if (seed) {
    const ins = db.prepare(`INSERT INTO events (id, slug, access_notes) VALUES (?, ?, ?)`);
    for (const r of FIXTURE) ins.run(r.id, r.slug, r.before);
  }
  return db;
}
const DATA_PART = MIGRATION.replace(/CREATE TABLE event_internal_notes \([\s\S]*?\);/, "");
const snapshot = (db: Database.Database) =>
  JSON.stringify([
    db.prepare(`SELECT id, access_notes FROM events ORDER BY id`).all(),
    db.prepare(`SELECT event_id, notes FROM event_internal_notes ORDER BY event_id`).all(),
  ]);

describe("drizzle/0367 data move", () => {
  it("leaves every row at its classified `after` value and moves the full original", () => {
    const db = freshDb(true);
    db["exec"](MIGRATION);
    const pub = new Map(
      (
        db.prepare(`SELECT id, access_notes FROM events`).all() as Array<{
          id: string;
          access_notes: string | null;
        }>
      ).map((r) => [r.id, r.access_notes])
    );
    const internal = new Map(
      (
        db.prepare(`SELECT event_id, notes FROM event_internal_notes`).all() as Array<{
          event_id: string;
          notes: string;
        }>
      ).map((r) => [r.event_id, r.notes])
    );
    for (const r of FIXTURE) {
      expect(pub.get(r.id), r.slug).toBe(r.after);
      if (r.class === "visitor") expect(internal.has(r.id), r.slug).toBe(false);
      else expect(internal.get(r.id), r.slug).toBe(PREFIX + r.before);
    }
    expect(internal.size).toBe(9);
  });

  it("leaves ZERO prose-shaped text in the public column", () => {
    const db = freshDb(true);
    db["exec"](MIGRATION);
    const leftovers = (
      db
        .prepare(`SELECT slug, access_notes FROM events WHERE access_notes IS NOT NULL`)
        .all() as Array<{
        slug: string;
        access_notes: string;
      }>
    ).filter((r) => accessNotesProseReason(r.access_notes) !== null);
    expect(leftovers).toEqual([]);
  });

  it("is idempotent: a second run changes nothing", () => {
    const db = freshDb(true);
    db["exec"](MIGRATION);
    const once = snapshot(db);
    db["exec"](DATA_PART);
    expect(snapshot(db)).toBe(once);
  });

  it("is a no-op on an empty DB (CI builds D1 from migrations)", () => {
    const db = freshDb(false);
    expect(() => db["exec"](MIGRATION)).not.toThrow();
    expect(db.prepare(`SELECT count(*) n FROM event_internal_notes`).get()).toEqual({ n: 0 });
  });

  it("does not touch a row someone edited after the review", () => {
    const db = freshDb(true);
    const target = FIXTURE.find((r) => r.class === "prose")!;
    db.prepare(`UPDATE events SET access_notes = ? WHERE id = ?`).run("Edited since.", target.id);
    db["exec"](MIGRATION);
    expect(db.prepare(`SELECT access_notes FROM events WHERE id = ?`).get(target.id)).toEqual({
      access_notes: "Edited since.",
    });
    expect(
      db.prepare(`SELECT count(*) n FROM event_internal_notes WHERE event_id = ?`).get(target.id)
    ).toEqual({ n: 0 });
  });
});

// ---------------------------------------------------------------------------
// update_event / get_event_details_admin
// ---------------------------------------------------------------------------
const AUTH = { userId: "u-admin", role: "ADMIN" as const };
let db: TestDb;
let server: CapturingMcpServer;

beforeEach(async () => {
  ({ db } = createTestDb());
  db.insert(users).values({ id: "u-admin", email: "admin@test", role: "ADMIN" }).run();
  db.insert(promoters)
    .values({ id: "p-1", companyName: "P", slug: "p" as never })
    .run();
  await db.insert(events).values({
    id: "ev-1",
    name: "Kingfield Craft Fair",
    slug: "kingfield-craft-fair" as never,
    promoterId: "p-1",
    status: "APPROVED",
  } as typeof events.$inferInsert);
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, AUTH, undefined);
  registerAdminEventReadTools(server as never, db, AUTH);
});

type ToolResult = { content: Array<{ text: string }>; isError?: boolean };
const call = (name: string, args: Record<string, unknown>) =>
  server.invoke(name, args) as Promise<ToolResult>;
const readAdmin = async () =>
  JSON.parse(
    (await call("get_event_details_admin", { event_id: "ev-1" })).content[0].text
  ) as Record<string, unknown>;

describe("update_event — access_notes / internal_notes", () => {
  it("refuses prose-shaped access_notes and writes nothing", async () => {
    const res = await call("update_event", {
      event_id: "ev-1",
      access_notes: "2026-08-03 sweep: date unverified — needs a call.",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("access_notes_looks_internal");
    const [row] = await db.select({ a: events.accessNotes }).from(events);
    expect(row.a).toBeNull();
  });

  it("accepts visitor copy", async () => {
    const res = await call("update_event", {
      event_id: "ev-1",
      access_notes: "Seniors 62+ $10. The first floor is fully accessible.",
    });
    expect(res.isError).toBeFalsy();
    expect((await readAdmin()).access_notes).toBe(
      "Seniors 62+ $10. The first floor is fully accessible."
    );
  });

  it("stores internal_notes on its own (no other field), reads it back, and clears it", async () => {
    const res = await call("update_event", {
      event_id: "ev-1",
      internal_notes: "VENUE CHECK: moved to Windsor.",
    });
    expect(res.isError).toBeFalsy();
    expect((await readAdmin()).internal_notes).toBe("VENUE CHECK: moved to Windsor.");
    // Never on the events row.
    const [evRow] = await db.select().from(events);
    expect(JSON.stringify(evRow)).not.toContain("VENUE CHECK");

    await call("update_event", { event_id: "ev-1", internal_notes: "second" });
    expect((await readAdmin()).internal_notes).toBe("second");

    await call("update_event", { event_id: "ev-1", internal_notes: "" });
    expect((await readAdmin()).internal_notes).toBeNull();
    expect(await db.select().from(eventInternalNotes)).toEqual([]);
  });
});

describe("no PUBLIC MCP path reads the private table", () => {
  it("only the admin event tools reference eventInternalNotes / event_internal_notes", () => {
    const dir = join(__dirname, "../src");
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.ts$/.test(e.name)) {
          // Code only: a comment naming the table is not a reader.
          const code = readFileSync(p, "utf8")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/^\s*\/\/.*$/gm, "");
          if (/eventInternalNotes|event_internal_notes/.test(code))
            hits.push(p.slice(dir.length + 1));
        }
      }
    };
    walk(dir);
    // Landmark: the two readers/writers exist. Any NEW file here is a review
    // point — is it admin-gated?
    expect(hits.sort()).toEqual(["tools/admin-event-read.ts", "tools/admin.ts"]);
  });
});
