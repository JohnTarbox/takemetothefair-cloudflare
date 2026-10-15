/**
 * OPE-1063 — drizzle/0366 moves operator/provenance prose out of the PUBLIC
 * `event_days.notes` before the render fix starts showing every day note.
 *
 * The fixture is the exact prod state of the 76 targeted rows, read on
 * 2026-10-15 and re-checked against prod with the migration's own predicates
 * (76/76 matched on `id` AND `notes`, existing internal_notes identical). The
 * test runs the REAL migration file and the REAL rollback file against it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Row = {
  id: string;
  slug: string;
  date: string;
  cls: "b" | "c";
  before: string;
  after: string | null;
  internal?: string;
};

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const MIGRATION = read("drizzle/0366_ope1063_day_notes_provenance_to_internal_notes.sql");
const ROLLBACK = read("scripts/rollback/0366_ope1063_day_notes_provenance.rollback.sql");
const SNAPSHOT: Row[] = JSON.parse(
  read("src/lib/__tests__/fixtures/ope1063-day-notes-snapshot.json")
);

/** The review's class-(b) test: does this public string read as operator
 *  provenance? Markers taken from the 2026-10-15 review. Shouting-caps
 *  "NOT PUBLISHED" is case-sensitive on purpose: a visitor-facing "Hours not
 *  published by the organizer" is honest copy, not provenance. */
const PROVENANCE =
  /\b(source:|confirmed via|verified|fetched|estimated|left null|deliberately|per organizer|per vendor contact|schema\.org|calendar link|eventbrite listing|per exeter|window covers|approximate close|hours per|hours based on|confirm closer|verify before|hours confirmed|hours from the organizer|per [a-z0-9-]+\.(org|com|gov|io)|per vendor recruitment|submitted flyer|carried over|single-day event|public hours|vendor setup from)/i;
const isOperatorProse = (s: string) => PROVENANCE.test(s) || /NOT PUBLISHED/.test(s);

let db: Database.Database;
const strip = (sql: string) => sql.replace(/^--[^\n]*\n/gm, "");
const runChanges = (sql: string) => {
  let n = 0;
  for (const stmt of strip(sql)
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean)) {
    n += db.prepare(stmt).run().changes;
  }
  return n;
};
const get = (id: string) =>
  db.prepare("SELECT notes, internal_notes FROM event_days WHERE id = ?").get(id) as {
    notes: string | null;
    internal_notes: string | null;
  };

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`CREATE TABLE event_days (id TEXT PRIMARY KEY, notes TEXT, internal_notes TEXT);`);
  const ins = db.prepare("INSERT INTO event_days (id, notes, internal_notes) VALUES (?, ?, ?)");
  for (const r of SNAPSHOT) ins.run(r.id, r.before, r.internal ?? null);
  // Bystanders: visitor notes and an edited-since row must not be touched.
  ins.run("visitor", "Fireworks at dusk", null);
  ins.run("visitor-not-published", "Saturday. Hours not published by the organizer.", null);
  ins.run(SNAPSHOT[0].id + "-twin", SNAPSHOT[0].before, null); // same text, different id
});

describe("0366 — provenance leaves the public day note", () => {
  it("the classifier flags every class-(b) original (sanity: it can see the problem)", () => {
    const missed = SNAPSHOT.filter((r) => r.cls === "b" && !isOperatorProse(r.before));
    expect(missed.map((r) => `${r.slug} ${r.date}`)).toEqual([]);
  });

  it("changes exactly the 76 snapshot rows, and a re-run changes nothing", () => {
    expect(runChanges(MIGRATION)).toBe(SNAPSHOT.length);
    expect(runChanges(MIGRATION)).toBe(0);
  });

  it("public notes become the visitor part (or NULL) and the classifier finds 0 provenance", () => {
    db.exec(MIGRATION);
    for (const r of SNAPSHOT) expect(get(r.id).notes).toBe(r.after);
    const leaks = SNAPSHOT.map((r) => get(r.id).notes).filter(
      (n): n is string => n !== null && isOperatorProse(n)
    );
    expect(leaks).toEqual([]);
  });

  it("no content is lost: the full original lands in internal_notes, after any prior text", () => {
    db.exec(MIGRATION);
    for (const r of SNAPSHOT) {
      expect(get(r.id).internal_notes).toBe(r.internal ? `${r.internal}\n${r.before}` : r.before);
    }
  });

  it("does not touch bystanders", () => {
    db.exec(MIGRATION);
    expect(get("visitor")).toEqual({ notes: "Fireworks at dusk", internal_notes: null });
    expect(get("visitor-not-published").notes).toBe(
      "Saturday. Hours not published by the organizer."
    );
    expect(get(SNAPSHOT[0].id + "-twin")).toEqual({
      notes: SNAPSHOT[0].before,
      internal_notes: null,
    });
  });

  it("is a no-op on an empty database (CI applies every migration to a fresh D1)", () => {
    db.exec("DELETE FROM event_days");
    expect(runChanges(MIGRATION)).toBe(0);
  });

  it("the rollback restores the exact prior state and is itself idempotent", () => {
    db.exec(MIGRATION);
    expect(runChanges(ROLLBACK)).toBe(SNAPSHOT.length);
    expect(runChanges(ROLLBACK)).toBe(0);
    for (const r of SNAPSHOT) {
      expect(get(r.id)).toEqual({ notes: r.before, internal_notes: r.internal ?? null });
    }
  });
});
