/**
 * OPE-384 stage 3 — the follow-up write order is enforced by the DATABASE.
 *
 * The sweep closes the silent attempt to `no_response` FIRST and only then
 * inserts the follow-up. That is not tidiness. The partial unique index from
 * drizzle/0205 covers `queued` and `sent` together, so a follow-up written
 * while the original still reads `sent` is a second OPEN ask for the same
 * event and the index rejects it.
 *
 * The DDL here is read out of the migration file rather than retyped, so if
 * somebody narrows the index to `('sent')` alone — which would silently permit
 * the double-ask this whole stage is built to prevent — this test changes its
 * mind with the schema instead of guarding a copy of it that no longer exists.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION = join(
  __dirname,
  "..",
  "..",
  "drizzle",
  "0205_ope384_promoter_outreach_attempts.sql"
);

/** Every CREATE statement in the migration that concerns this one table. */
function outreachDdl(): string[] {
  const sql = readFileSync(MIGRATION, "utf8");
  // Strip line comments BEFORE splitting. This migration's prose contains
  // semicolons, so splitting first cuts comment lines in half and leaves
  // fragments that no longer look like comments.
  const stripped = sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
  return stripped
    .split(";")
    .map((s) => s.trim())
    .filter((s) => /^CREATE /i.test(s) && /promoter_outreach_attempts/.test(s))
    .map((s) => s + ";");
}

let db: Database.Database;

const insert = (id: string, eventId: string | null, status: string) =>
  db
    .prepare(
      `INSERT INTO promoter_outreach_attempts
         (id, promoter_id, event_id, channel, to_address, subject, body_text, status, created_at)
       VALUES (?, 'p1', ?, 'email', 'a@b.test', 's', 'b', ?, 0)`
    )
    .run(id, eventId, status);

beforeEach(() => {
  db = new Database(":memory:");
  // better-sqlite3 enforces foreign keys by default, and the real table
  // references both parents. Stubs keep that enforcement ON rather than
  // switching off a constraint just to make a fixture load.
  db.exec(
    "CREATE TABLE promoters (id TEXT PRIMARY KEY); CREATE TABLE events (id TEXT PRIMARY KEY);"
  );
  db.prepare("INSERT INTO promoters (id) VALUES ('p1')").run();
  db.prepare("INSERT INTO events (id) VALUES ('evt-1')").run();
  const ddl = outreachDdl();
  // If the migration stopped creating the table or the index, every assertion
  // below would pass vacuously against an empty schema.
  expect(ddl.some((s) => /CREATE TABLE/i.test(s))).toBe(true);
  expect(ddl.some((s) => /CREATE UNIQUE INDEX/i.test(s))).toBe(true);
  for (const stmt of ddl) db.exec(stmt);
});

describe("one open ask per event", () => {
  it("REFUSES a queued follow-up while the original is still `sent`", () => {
    insert("a1", "evt-1", "sent");
    expect(() => insert("a2", "evt-1", "queued")).toThrow(/UNIQUE/i);
  });

  it("accepts the follow-up once the original has been closed to no_response", () => {
    insert("a1", "evt-1", "sent");
    db.prepare(
      "UPDATE promoter_outreach_attempts SET status = 'no_response' WHERE id = 'a1'"
    ).run();
    expect(() => insert("a2", "evt-1", "queued")).not.toThrow();

    const rows = db
      .prepare("SELECT status FROM promoter_outreach_attempts WHERE event_id = 'evt-1' ORDER BY id")
      .all() as Array<{ status: string }>;
    expect(rows.map((r) => r.status)).toEqual(["no_response", "queued"]);
  });

  it("refuses two queued asks for one event, not just queued-against-sent", () => {
    // `queued` is open too — a gate-refused draft still holds the slot, which
    // is what stops a switched-off rail from accumulating duplicate drafts.
    insert("a1", "evt-1", "queued");
    expect(() => insert("a2", "evt-1", "queued")).toThrow(/UNIQUE/i);
  });

  it("lets a closed history pile up — the index only guards OPEN asks", () => {
    insert("a1", "evt-1", "no_response");
    insert("a2", "evt-1", "bounced");
    insert("a3", "evt-1", "confirmed");
    expect(() => insert("a4", "evt-1", "sent")).not.toThrow();
  });

  it("does not constrain promoter-level asks, which carry no event_id", () => {
    insert("a1", null, "sent");
    expect(() => insert("a2", null, "sent")).not.toThrow();
  });
});
