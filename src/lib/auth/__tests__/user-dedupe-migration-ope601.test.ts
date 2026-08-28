/**
 * OPE-601 scopes 5 + 6 — the deletion John authorized, and the drift guard.
 *
 * A destructive migration deserves tests about what it REFUSES to do far more
 * than about what it does. `vendors.user_id` cascades on delete, so a duplicate
 * that had acquired a vendor row would take that vendor with it — and the row
 * is a real person's, so there is no undo for either.
 *
 * The guards are therefore re-checked at APPLY time rather than trusted from
 * the moment the migration was written, and these tests pin that. The first
 * two are the ones that matter; the rest are the bulk-mutation-discipline
 * properties (idempotent, no-op on an empty DB).
 *
 * Separate file from `email-case-identity-ope601.test.ts` because that one is
 * about the identity RULE and this one is about a one-shot data change; they
 * age differently and a reader looking for either should not have to scroll
 * past the other.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

const ROOT = process.cwd();
const MIGRATION = readFileSync(
  join(ROOT, "drizzle/0248_ope601_dedupe_user_and_lower_email_index.sql"),
  "utf8"
);

const DUP = "96142359-378b-4454-b172-0824be7b85bc";
const KEEPER = "b670e4ac-79e1-415e-90b3-87c2ee7e3157";

const SCHEMA = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE,
    name TEXT, role TEXT, email_verified INTEGER
  );
  CREATE TABLE vendors (id TEXT PRIMARY KEY, user_id TEXT, business_name TEXT);
  CREATE TABLE promoters (id TEXT PRIMARY KEY, user_id TEXT);
  CREATE TABLE performers (id TEXT PRIMARY KEY, user_id TEXT);
  CREATE TABLE user_favorites (id TEXT PRIMARY KEY, user_id TEXT);
  CREATE TABLE entity_claims (id TEXT PRIMARY KEY, user_id TEXT);
`;

function seed(opts: { dupOwnsVendor?: boolean } = {}) {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  const ins = db.prepare(
    `INSERT INTO users (id, email, name, role, email_verified) VALUES (?, ?, ?, ?, ?)`
  );
  // Jan's real, verified account — the keeper.
  ins.run(KEEPER, "admin@kewlkandylz.com", "Jan Merrill", "VENDOR", 1);
  // The duplicate her second registration created on 2026-08-07.
  ins.run(DUP, "Admin@kewlkandylz.com", "Jan Merrill", "VENDOR", null);
  ins.run("other1", "someone@example.com", "Someone", "USER", 1);

  db.prepare(`INSERT INTO vendors (id, user_id, business_name) VALUES (?, ?, ?)`).run(
    "v-keeper",
    KEEPER,
    "Kewl Kandylz"
  );
  if (opts.dupOwnsVendor) {
    db.prepare(`INSERT INTO vendors (id, user_id, business_name) VALUES (?, ?, ?)`).run(
      "v-dup",
      DUP,
      "Something The Duplicate Owns"
    );
  }
  return db;
}

const userIds = (db: Database.Database) =>
  (db.prepare(`SELECT id FROM users ORDER BY id`).all() as { id: string }[]).map((r) => r.id);
const vendorIds = (db: Database.Database) =>
  (db.prepare(`SELECT id FROM vendors ORDER BY id`).all() as { id: string }[]).map((r) => r.id);

describe("0248 — deletes the duplicate ONLY while it owns nothing", () => {
  it("removes the duplicate and leaves the keeper — and its vendor — untouched", () => {
    const db = seed();
    db.exec(MIGRATION);
    expect(userIds(db)).not.toContain(DUP);
    expect(userIds(db)).toContain(KEEPER);
    // The cascade risk, pinned: the keeper's vendor must survive.
    expect(vendorIds(db)).toEqual(["v-keeper"]);
  });

  it("REFUSES to delete once the duplicate owns a vendor — the cascade guard", () => {
    // State can change between a migration being written and being applied.
    // Deleting here would silently take a vendor row with it, and neither the
    // user nor the vendor can be restored. So the guard has to hold at APPLY
    // time, not at the moment someone reasoned about prod.
    const db = seed({ dupOwnsVendor: true });

    // The DELETE no-ops, the collision therefore survives, and the UNIQUE
    // index then fails LOUDLY — aborting the deploy and putting a human in
    // front of it rather than quietly destroying something that mattered.
    expect(() => db.exec(MIGRATION)).toThrow();

    expect(userIds(db)).toContain(DUP);
    expect(vendorIds(db)).toContain("v-dup");
  });

  it("builds the LOWER(email) index, which then rejects a case-variant insert", () => {
    const db = seed();
    db.exec(MIGRATION);
    // The drift guard doing its job. `admin@` exists, so `ADMIN@` can no longer
    // be stored alongside it — the plain UNIQUE(email) index allowed exactly
    // that, which is how the duplicate arose in the first place.
    expect(() =>
      db
        .prepare(`INSERT INTO users (id, email, name, role, email_verified) VALUES (?,?,?,?,?)`)
        .run("newdup", "ADMIN@kewlkandylz.com", "Jan Merrill", "VENDOR", null)
    ).toThrow();
  });

  it("is idempotent — a second run changes nothing and does not throw", () => {
    const db = seed();
    db.exec(MIGRATION);
    const before = db.prepare(`SELECT id, email FROM users ORDER BY id`).all();
    expect(() => db.exec(MIGRATION)).not.toThrow();
    expect(db.prepare(`SELECT id, email FROM users ORDER BY id`).all()).toEqual(before);
  });

  it("is a no-op on an empty database — CI applies every migration to a fresh D1", () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA);
    expect(() => db.exec(MIGRATION)).not.toThrow();
    expect(db.prepare(`SELECT COUNT(*) n FROM users`).get()).toEqual({ n: 0 });
  });
});
