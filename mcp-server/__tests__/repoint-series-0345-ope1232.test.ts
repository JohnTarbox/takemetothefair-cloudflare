/**
 * OPE-1232 — drizzle/0345 against SQLite: a series on a merge tombstone moves
 * to the ACTIVE keeper named by slug history; a series on a never-merged
 * INACTIVE (former) venue, and one whose keeper is itself retired, stay put.
 * Applied twice (idempotent), and on an empty database (no-op).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestDb } from "./setup-db.js";

const SQL = readFileSync(
  join(__dirname, "../../drizzle/0345_ope1232_repoint_series_off_venue_tombstones.sql"),
  "utf8"
);

function seed(raw: ReturnType<typeof createTestDb>["raw"]) {
  const v = raw.prepare(
    "INSERT INTO venues (id, name, slug, address, city, state, zip, status) VALUES (?, ?, ?, '1 Main', 'X', 'VT', '05000', ?)"
  );
  v.run("keeper", "Tunbridge Fairgrounds", "tunbridge-fairgrounds", "ACTIVE");
  v.run("tomb", "The Tunbridge Fair", "the-tunbridge-fair-merged-65be445f", "INACTIVE");
  v.run("former", "Montpelier Fairgrounds", "montpelier-fairgrounds", "INACTIVE");
  v.run("dead-keeper", "Old Keeper", "old-keeper", "INACTIVE");
  v.run("tomb2", "Chained", "chained-merged-11111111", "INACTIVE");
  const h = raw.prepare(
    "INSERT INTO venue_slug_history (id, venue_id, old_slug, new_slug, changed_at) VALUES (?, ?, ?, ?, 1)"
  );
  h.run("h1", "keeper", "the-tunbridge-fair-merged-65be445f", "tunbridge-fairgrounds");
  h.run("h2", "dead-keeper", "chained-merged-11111111", "old-keeper");
  const s = raw.prepare(
    "INSERT INTO event_series (id, canonical_slug, name, venue_id) VALUES (?, ?, ?, ?)"
  );
  s.run("s-tomb", "tunbridge-worlds-fair", "Tunbridge World's Fair", "tomb");
  s.run("s-former", "montpelier-fair", "Montpelier Fair", "former");
  s.run("s-chain", "chained-fair", "Chained Fair", "tomb2");
}
const venueOf = (raw: ReturnType<typeof createTestDb>["raw"]) =>
  Object.fromEntries(
    (
      raw.prepare("SELECT id, venue_id FROM event_series ORDER BY id").all() as Array<{
        id: string;
        venue_id: string;
      }>
    ).map((r) => [r.id, r.venue_id])
  );

describe("drizzle/0345 (OPE-1232)", () => {
  it("repoints only tombstoned series with an ACTIVE keeper, idempotently", () => {
    const { raw } = createTestDb();
    seed(raw);
    raw.exec(SQL);
    raw.exec(SQL);
    expect(venueOf(raw)).toEqual({ "s-chain": "tomb2", "s-former": "former", "s-tomb": "keeper" });
  });
  it("is a no-op on an empty database", () => {
    const { raw } = createTestDb();
    expect(() => raw.exec(SQL)).not.toThrow();
    expect(raw.prepare("SELECT COUNT(*) n FROM event_series").get()).toEqual({ n: 0 });
  });
});
