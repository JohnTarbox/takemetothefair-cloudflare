/**
 * OPE-573 — `findNameCollision` against a real SQLite database.
 *
 * The route-level tests in `src/app/api/auth/__tests__/register.test.ts` mock
 * the db, so they prove the ORDERING (no account is created before the check)
 * but never execute this query. A mocked `.limit()` returns whatever the test
 * says regardless of whether the column names are right, so a rename would
 * sail through. This file runs the real statement.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/lib/db/schema";
import {
  findNameCollision,
  nameCollisionMessage,
  isUniqueConstraintError,
} from "../signup-name-collision";

const SCHEMA_SQL = `
  CREATE TABLE vendors (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    business_name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    claimed INTEGER DEFAULT 0
  );
  CREATE TABLE promoters (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    company_name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    claimed INTEGER DEFAULT 0
  );
`;

let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

function seedVendor(slug: string, name: string, claimed = 0) {
  raw
    .prepare(
      `INSERT INTO vendors (id, user_id, business_name, slug, claimed) VALUES (?, 'u1', ?, ?, ?)`
    )
    .run(`v-${slug}`, name, slug, claimed);
}

describe("findNameCollision — the three real prod cases", () => {
  // Every collision observed on prod was against a listing that ALREADY
  // describes that business. That is why the fix routes to the claim flow
  // instead of auto-suffixing: `21-street-beads-2` would duplicate a real row.
  it.each([
    ["21 Street Beads", "21-street-beads"],
    ["Kewl Kandylz", "kewl-kandylz"],
    ["Gooseberry Leather Company", "gooseberry-leather-company"],
  ])("detects %s colliding onto %s", async (typedName, existingSlug) => {
    seedVendor(existingSlug, typedName);
    const hit = await findNameCollision(db as never, "VENDOR", typedName);
    expect(hit?.slug).toBe(existingSlug);
    expect(hit?.claimUrl).toBe(`/claim/vendor/${existingSlug}`);
  });

  it("returns null when the name is free — signup must proceed", async () => {
    seedVendor("21-street-beads", "21 Street Beads");
    expect(await findNameCollision(db as never, "VENDOR", "Totally New Crafts")).toBeNull();
  });

  it("matches on the SLUG, not the raw string — punctuation and case differ", async () => {
    // The collision is a slug collision, so these must all be caught even
    // though none equals the stored business_name.
    seedVendor("kewl-kandylz", "Kewl Kandylz ");
    for (const typed of ["kewl kandylz", "KEWL KANDYLZ", "Kewl  Kandylz!"]) {
      expect((await findNameCollision(db as never, "VENDOR", typed))?.slug).toBe("kewl-kandylz");
    }
  });

  it("reports claimed state, which changes the wording", async () => {
    seedVendor("acme-crafts", "Acme Crafts", 1);
    const hit = await findNameCollision(db as never, "VENDOR", "Acme Crafts");
    expect(hit?.claimed).toBe(true);
    expect(nameCollisionMessage(hit!)).toContain("already listed and claimed");
  });

  it("an empty slug never matches, even when an empty-slug row exists", async () => {
    // createSlug("!!!") is "". The guard matters only if some row can HOLD "",
    // so seed one — otherwise the lookup finds nothing anyway and the test
    // passes with the guard deleted (it did, on the first version).
    //
    // Without the guard, every punctuation-only business name would collide
    // with this row and the person would be told to claim it.
    seedVendor("real-vendor", "Real Vendor");
    raw
      .prepare(
        `INSERT INTO vendors (id, user_id, business_name, slug, claimed) VALUES ('v-empty','u1','Legacy Row','',0)`
      )
      .run();
    expect(await findNameCollision(db as never, "VENDOR", "!!!")).toBeNull();
    expect(await findNameCollision(db as never, "VENDOR", "   ")).toBeNull();
  });

  it("promoters are looked up in their own table, not vendors", async () => {
    // Seeded only as a VENDOR — a promoter signup with the same name must NOT
    // collide, or the two directories would block each other.
    seedVendor("acme-events", "Acme Events");
    expect(await findNameCollision(db as never, "PROMOTER", "Acme Events")).toBeNull();

    raw
      .prepare(
        `INSERT INTO promoters (id, user_id, company_name, slug, claimed) VALUES ('p1','u1','Acme Events','acme-events',0)`
      )
      .run();
    const hit = await findNameCollision(db as never, "PROMOTER", "Acme Events");
    expect(hit?.claimUrl).toBe("/claim/promoter/acme-events");
  });
});

describe("nameCollisionMessage never leaks driver text", () => {
  it("names the listing and says nothing about SQL", async () => {
    seedVendor("21-street-beads", "21 Street Beads");
    const msg = nameCollisionMessage(
      (await findNameCollision(db as never, "VENDOR", "21 Street Beads"))!
    );
    expect(msg).toContain("21 Street Beads");
    expect(msg).not.toMatch(/UNIQUE|SQLITE|D1_ERROR|constraint/i);
  });
});

describe("isUniqueConstraintError — the backstop's trigger", () => {
  it("matches the exact string D1 produced in prod", () => {
    expect(
      isUniqueConstraintError(
        new Error(
          "D1_ERROR: UNIQUE constraint failed: vendors.slug: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)"
        )
      )
    ).toBe(true);
  });

  it("matches a promoters collision too — not pinned to one column", () => {
    expect(
      isUniqueConstraintError(new Error("D1_ERROR: UNIQUE constraint failed: promoters.slug"))
    ).toBe(true);
  });

  it("does NOT swallow unrelated failures", () => {
    // ⚠️ The backstop rethrows anything this rejects. Matching too broadly here
    // would convert a real outage into a friendly "name is taken" and hide it.
    for (const other of [
      new Error("D1_ERROR: no such table: vendors"),
      new Error("NOT NULL constraint failed: vendors.business_name"),
      new Error("network timeout"),
    ]) {
      expect(isUniqueConstraintError(other)).toBe(false);
    }
  });

  it("survives a non-Error throw", () => {
    expect(isUniqueConstraintError("UNIQUE constraint failed: vendors.slug")).toBe(true);
    expect(isUniqueConstraintError(null)).toBe(false);
    expect(isUniqueConstraintError(undefined)).toBe(false);
  });
});
