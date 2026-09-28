/**
 * OPE-1211 — drizzle/0337 moves June batch-backfill provenance out of the
 * public `event_days.notes` into `internal_notes`.
 *
 * Runs the REAL migration file against fixture rows: every one of the nine
 * measured values moves, and nothing else is touched — the mixed
 * prose-plus-source rows (OPE-572), a row whose internal_notes is already set,
 * and ordinary visitor notes. A second run changes nothing (idempotent).
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SQL = readFileSync(
  join(process.cwd(), "drizzle/0337_ope1211_event_days_provenance_to_internal_notes.sql"),
  "utf8"
);

const PROVENANCE = [
  "backfilled from description (UX-R1 Wave 2, 2026-06-03)",
  "auto-weekly-backfill 2026-06-21",
  "backfilled from description (UX-R1, 2026-06-02)",
  "backfilled by cadence-expander 2026-06-13 (src: description)",
  "backfilled by cadence-expander 2026-06-13 (src: granitetheatre.org)",
  "backfilled by cadence-expander 2026-06-13 (src: capecodchambermusic.org)",
  "backfilled by cadence-expander 2026-06-13 (src: makefoodyourbusiness.org)",
  "corrected by verification 2026-06-13 (src: downtownworcester.org)",
  "backfilled by cadence-expander 2026-06-13 (src: name-cadence)",
];

let db: Database.Database;
const row = (id: string) =>
  db.prepare("SELECT notes, internal_notes FROM event_days WHERE id = ?").get(id) as {
    notes: string | null;
    internal_notes: string | null;
  };

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`CREATE TABLE event_days (id TEXT PRIMARY KEY, notes TEXT, internal_notes TEXT);`);
  const ins = db.prepare("INSERT INTO event_days (id, notes, internal_notes) VALUES (?, ?, ?)");
  PROVENANCE.forEach((v, i) => ins.run(`p${i}`, v, null));
  ins.run("empty-internal", PROVENANCE[1], "");
  ins.run("mixed", "Parade at 2 PM. Source: marshfieldfair.org", null);
  ins.run("prefix-plus-prose", `${PROVENANCE[1]} — gates open at 9`, null);
  ins.run("already-internal", PROVENANCE[0], "operator note kept");
  ins.run("visitor", "Fireworks at dusk", null);
});

describe("0337 — provenance leaves the public note", () => {
  it("each of the nine values moves to internal_notes and notes is cleared", () => {
    db.exec(SQL);
    PROVENANCE.forEach((v, i) => {
      expect(row(`p${i}`)).toEqual({ notes: null, internal_notes: v });
    });
    expect(row("empty-internal")).toEqual({ notes: null, internal_notes: PROVENANCE[1] });
  });

  it("nothing else is touched", () => {
    db.exec(SQL);
    expect(row("mixed").notes).toBe("Parade at 2 PM. Source: marshfieldfair.org");
    expect(row("prefix-plus-prose").notes).toBe(`${PROVENANCE[1]} — gates open at 9`);
    expect(row("already-internal")).toEqual({
      notes: PROVENANCE[0],
      internal_notes: "operator note kept",
    });
    expect(row("visitor")).toEqual({ notes: "Fireworks at dusk", internal_notes: null });
  });

  it("changes exactly the matching rows, and a re-run changes nothing", () => {
    const run = () => db.prepare(SQL.replace(/--[^\n]*\n/g, "")).run().changes;
    expect(run()).toBe(PROVENANCE.length + 1);
    expect(run()).toBe(0);
  });
});
