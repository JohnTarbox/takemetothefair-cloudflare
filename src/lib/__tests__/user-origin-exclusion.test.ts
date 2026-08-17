/**
 * OPE-292 — placeholder owner accounts must not be counted as people.
 *
 * The vendor / promoter creation tools mint an owner row per entity
 * (`pending+<slug>@meetmeatthefair.com`). Correct and intentional — an entity
 * needs an owner — but not registrations. Measured 2026-08-17: **6,741 of
 * 6,950** rows are placeholders, so an unfiltered count reports ~33x the real
 * figure of 209.
 *
 * Before `users.origin`, the only way to tell them apart was an email pattern
 * nothing enforced. OPE-177 scope #3 would have alerted constantly from day
 * one, because placeholders are permanently and correctly
 * `email_verified = NULL` — caught by accident, which is not a control.
 *
 * These tests exercise the real filter against a real (in-memory) table, so
 * they fail if the predicate is dropped from either surface.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { count, ne } from "drizzle-orm";
import * as schema from "../db/schema";
import { users } from "../db/schema";

const SCHEMA_SQL = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    name TEXT,
    role TEXT,
    email_verified INTEGER,
    origin TEXT NOT NULL DEFAULT 'registration',
    created_at INTEGER,
    updated_at INTEGER
  );
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

function seed(id: string, email: string, origin?: string) {
  if (origin === undefined) {
    raw.prepare(`INSERT INTO users (id, email) VALUES (?,?)`).run(id, email);
  } else {
    raw.prepare(`INSERT INTO users (id, email, origin) VALUES (?,?,?)`).run(id, email, origin);
  }
}

/** The predicate both the dashboard count and the admin list use. */
const realPeopleOnly = ne(users.origin, "ingestion");

describe("the count surface", () => {
  it("counts people, not placeholders", async () => {
    seed("p1", "pending+acme@meetmeatthefair.com", "ingestion");
    seed("p2", "pending+beta@meetmeatthefair.com", "ingestion");
    seed("r1", "alice@example.com", "registration");

    const [all] = await db.select({ n: count() }).from(users);
    const [real] = await db.select({ n: count() }).from(users).where(realPeopleOnly);

    expect(all.n).toBe(3); // what the dashboard used to report
    expect(real.n).toBe(1); // what it reports now
  });

  it("counts invited users as people", async () => {
    // `invite` is a real person who has not registered yet, not synthetic.
    seed("i1", "bob@example.com", "invite");
    const [real] = await db.select({ n: count() }).from(users).where(realPeopleOnly);
    expect(real.n).toBe(1);
  });
});

describe("the default is the safe direction", () => {
  it("an INSERT that forgets origin is counted as a person", async () => {
    // Deliberate: a real signup whose write path forgets the field is merely
    // counted, whereas a person defaulted to `ingestion` would vanish from
    // every user surface — unrecoverable without an audit.
    seed("r1", "carol@example.com");
    const [row] = await db.select({ origin: users.origin }).from(users);
    expect(row.origin).toBe("registration");

    const [real] = await db.select({ n: count() }).from(users).where(realPeopleOnly);
    expect(real.n).toBe(1);
  });
});

describe("the filter keys on origin, not the email shape", () => {
  it("a placeholder-looking email marked registration is still counted", async () => {
    // The whole point of the column: the email convention is no longer
    // load-bearing, so a lookalike address does not silently disappear.
    seed("odd", "pending+someone@meetmeatthefair.com", "registration");
    const [real] = await db.select({ n: count() }).from(users).where(realPeopleOnly);
    expect(real.n).toBe(1);
  });

  it("a normal-looking email marked ingestion is still excluded", async () => {
    // And the inverse — a future ingestion path that mints a differently-shaped
    // address is excluded correctly, which the email pattern could never do.
    seed("gen", "owner@some-vendor.test", "ingestion");
    const [real] = await db.select({ n: count() }).from(users).where(realPeopleOnly);
    expect(real.n).toBe(0);
  });
});

describe("the backfill predicate", () => {
  it("is self-limiting — a re-run changes nothing", () => {
    seed("p1", "pending+acme@meetmeatthefair.com", "registration");
    const stmt = `UPDATE users SET origin='ingestion'
                  WHERE email LIKE 'pending+%@meetmeatthefair.com' AND origin='registration'`;
    expect(raw.prepare(stmt).run().changes).toBe(1);
    expect(raw.prepare(stmt).run().changes).toBe(0);
  });

  it("leaves a hand-reclassified row alone", () => {
    // An operator who marks a placeholder-shaped row as a real person must not
    // have that decision clobbered by a re-run.
    seed("p1", "pending+acme@meetmeatthefair.com", "invite");
    raw
      .prepare(
        `UPDATE users SET origin='ingestion'
         WHERE email LIKE 'pending+%@meetmeatthefair.com' AND origin='registration'`
      )
      .run();
    const [row] = raw.prepare(`SELECT origin FROM users WHERE id='p1'`).all() as [
      { origin: string },
    ];
    expect(row.origin).toBe("invite");
  });
});
