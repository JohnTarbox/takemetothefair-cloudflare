/**
 * OPE-601 — `users.email` is a case-insensitive identity key.
 *
 * The defect was never "one site forgot to lowercase". It was that SOME sites
 * did and some did not, and the split is what made it unreadable to the user
 * who hit it:
 *
 *   register           did NOT fold  -> a second account on the same mailbox
 *   login              did NOT fold  -> that mailbox cannot sign in
 *   forgot-password    DID fold      -> but only finds a lowercase-STORED row
 *   send-verification  DID fold      -> same
 *
 * So a person could reset their password successfully and then be told, at
 * sign-in, that no such account exists. That is Jan Merrill's 2026-08-07
 * timeline exactly, and it ended with a duplicate registration that 500'd.
 *
 * These tests are in three layers on purpose. The unit test pins the
 * normalizer; the WIRING test pins that every site uses it, which is the
 * property that was actually violated; and the migration test reproduces the
 * seeded mixed-case pair the acceptance criterion asks for.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { normalizeEmail } from "../normalize-email";

const ROOT = process.cwd();

describe("normalizeEmail", () => {
  it("folds case across the whole address, local part included", () => {
    // Deliberate: RFC 5321 leaves local-part case to the receiving host, but no
    // major provider distinguishes it, and a user who capitalises their own
    // address has not entered a different one.
    expect(normalizeEmail("Admin@KewlKandylz.com")).toBe("admin@kewlkandylz.com");
    expect(normalizeEmail("jim@mfeSelfDefense.com")).toBe("jim@mfeselfdefense.com");
  });

  it("trims, because a trailing space is not a different mailbox", () => {
    expect(normalizeEmail("  Angelacurtis14@aol.com \n")).toBe("angelacurtis14@aol.com");
  });

  it("treats nullish as no address rather than throwing", () => {
    expect(normalizeEmail(undefined)).toBe("");
    expect(normalizeEmail(null)).toBe("");
  });
});

/**
 * The wiring. This is the layer that matters.
 *
 * A behavioural test of any ONE route would have passed before this fix —
 * forgot-password was already correct. What needs asserting is that no
 * email-keyed path is left unfolded, which is a property of the SET of call
 * sites, not of any member of it.
 */
describe("every email-keyed auth path normalizes", () => {
  const SITES: ReadonlyArray<{ file: string; why: string }> = [
    { file: "src/lib/auth.ts", why: "login + OAuth account lookup" },
    { file: "src/app/api/auth/register/route.ts", why: "duplicate check + the insert" },
    { file: "src/app/api/auth/forgot-password/route.ts", why: "password reset" },
    { file: "src/app/api/auth/send-verification/route.ts", why: "verification resend" },
  ];

  it.each(SITES)("$file normalizes ($why)", ({ file }) => {
    const src = readFileSync(join(ROOT, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    // The opening paren is required: a bare symbol also matches the
    // `import { normalizeEmail }` line, which would pass on a file that
    // imports the helper and never calls it.
    expect(src).toMatch(/normalizeEmail\(/);
    // And no site may quietly go back to a local fold — that divergence IS the
    // bug, and it is invisible because each site looks fine on its own.
    expect(src).not.toMatch(/\.email[^\n]*\.toLowerCase\(\)/);
  });
});

/**
 * The migration, against the seeded mixed-case pair the acceptance names.
 *
 * Reproduces the real prod shape: eight capitalised singletons plus ONE
 * colliding pair. The pair is the whole point — a naive
 * `UPDATE users SET email = LOWER(email)` passes every test written about the
 * singletons and then aborts in production on the UNIQUE index.
 */
describe("0245 backfill — lowercases singletons, refuses to break the collision", () => {
  const MIGRATION = readFileSync(
    join(ROOT, "drizzle/0245_ope601_lowercase_user_emails.sql"),
    "utf8"
  );

  function seed() {
    const db = new Database(":memory:");
    db["exec"](`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE);`);
    const ins = db["prepare"](`INSERT INTO users (id, email) VALUES (?, ?)`);
    // The colliding pair — Jan's live account and her duplicate.
    ins.run("b670e4ac", "admin@kewlkandylz.com");
    ins.run("96142359", "Admin@kewlkandylz.com");
    // A capitalised singleton — locked out today, and safe to fold.
    ins.run("3ca5f2c1", "Marleny.Abreu@unitedwayri.org");
    // An already-lowercase row, which must not be touched.
    ins.run("aaaa1111", "someone@example.com");
    return db;
  }

  it("folds the singleton", () => {
    const db = seed();
    db["exec"](MIGRATION);
    const row = db["prepare"](`SELECT email FROM users WHERE id = '3ca5f2c1'`).get() as {
      email: string;
    };
    expect(row.email).toBe("marleny.abreu@unitedwayri.org");
  });

  it("leaves the colliding row alone instead of aborting", () => {
    const db = seed();
    // The naive form throws here; this one must not.
    expect(() => db["exec"](MIGRATION)).not.toThrow();
    const rows = db["prepare"](`SELECT id, email FROM users ORDER BY id`).all() as {
      id: string;
      email: string;
    }[];
    const dup = rows.find((r) => r.id === "96142359");
    expect(dup?.email).toBe("Admin@kewlkandylz.com");
    // Jan's real account is untouched and still findable by a normalized login,
    // which is what actually unlocks her.
    expect(rows.find((r) => r.id === "b670e4ac")?.email).toBe("admin@kewlkandylz.com");
  });

  it("is idempotent — a second run changes nothing", () => {
    const db = seed();
    db["exec"](MIGRATION);
    const before = db["prepare"](`SELECT id, email FROM users ORDER BY id`).all();
    db["exec"](MIGRATION);
    const after = db["prepare"](`SELECT id, email FROM users ORDER BY id`).all();
    expect(after).toEqual(before);
  });

  it("is a no-op on an empty database", () => {
    // CI applies every migration to a fresh D1; an abort here kills the run.
    const db = new Database(":memory:");
    db["exec"](`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE);`);
    expect(() => db["exec"](MIGRATION)).not.toThrow();
  });
});
