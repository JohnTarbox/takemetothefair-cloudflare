/**
 * OPE-986 — a near-duplicate self-registration leaves a visible receipt.
 *
 * The fixture is the 2026-09-13 incident: "Sansa Studio Creations" at 17:37 and
 * "Sanza Studio Creations" at 17:45, same person, different typo'd addresses.
 * Every assertion reads the DURABLE error_logs row, because "the function
 * returned a match" is not what an operator can see.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/lib/db/schema";
import {
  flagNearDuplicateVendorRegistration,
  nearDuplicateReasons,
} from "../near-duplicate-registration";

const SCHEMA_SQL = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT, role TEXT, origin TEXT
  );
  CREATE TABLE vendors (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, business_name TEXT NOT NULL,
    slug TEXT NOT NULL, claimed INTEGER DEFAULT 0, claimed_by TEXT, created_at INTEGER
  );
  CREATE TABLE error_logs (
    id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, level TEXT, message TEXT NOT NULL,
    context TEXT, url TEXT, method TEXT, status_code INTEGER, stack_trace TEXT,
    user_agent TEXT, source TEXT, route TEXT, digest TEXT
  );
`;

const NOW = new Date("2026-09-13T17:45:02Z");
const minutesAgo = (m: number) => Math.floor((NOW.getTime() - m * 60_000) / 1000);

let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

function seed(opts: {
  vendorId: string;
  userId: string;
  businessName: string;
  ownerName: string;
  email: string;
  minutesAgo: number;
  selfRegistered?: boolean;
}) {
  raw
    .prepare(`INSERT INTO users (id, email, name, role, origin) VALUES (?,?,?,?,?)`)
    .run(opts.userId, opts.email, opts.ownerName, "VENDOR", "registration");
  const self = opts.selfRegistered ?? true;
  raw
    .prepare(
      `INSERT INTO vendors (id, user_id, business_name, slug, claimed, claimed_by, created_at)
       VALUES (?,?,?,?,?,?,?)`
    )
    .run(
      opts.vendorId,
      opts.userId,
      opts.businessName,
      opts.vendorId,
      self ? 1 : 0,
      self ? opts.userId : null,
      minutesAgo(opts.minutesAgo)
    );
}

const logs = () =>
  raw
    .prepare(`SELECT level, source, message, context FROM error_logs ORDER BY timestamp`)
    .all() as Array<{ level: string; source: string; message: string; context: string }>;

// The just-created second signup.
const SECOND = {
  vendorId: "v-sanza",
  userId: "u-sanza",
  businessName: "Sanza Studio Creations",
  ownerName: "Douglas Souza",
  email: "sanzaarts@gmail.vom",
};

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
  vi.spyOn(console, "error").mockImplementation(() => {});
  seed({ ...SECOND, minutesAgo: 0 });
});

describe("nearDuplicateReasons", () => {
  it("matches the incident pair on business name AND owner+email", () => {
    expect(
      nearDuplicateReasons(SECOND, {
        businessName: "Sansa Studio Creations",
        ownerName: "Douglas Souza",
        email: "sanzaart@gmail.com",
      })
    ).toEqual(["similar_business_name", "same_owner_name_similar_email"]);
  });

  it("does not match two different makers with different names", () => {
    expect(
      nearDuplicateReasons(SECOND, {
        businessName: "Blue Heron Pottery",
        ownerName: "Ann Marsh",
        email: "ann@blueheron.com",
      })
    ).toEqual([]);
  });

  it("does not treat a shared common first-and-last name alone as a match", () => {
    expect(
      nearDuplicateReasons(
        { businessName: "Pine Cone Candles", ownerName: "John Smith", email: "pinecone@x.com" },
        { businessName: "Lobster Trap Art", ownerName: "John Smith", email: "trapart@y.com" }
      )
    ).toEqual([]);
  });
});

describe("flagNearDuplicateVendorRegistration", () => {
  it("logs ONE warn row naming both vendor ids and both user ids", async () => {
    seed({
      vendorId: "v-sansa",
      userId: "u-sansa",
      businessName: "Sansa Studio Creations",
      ownerName: "Douglas Souza",
      email: "sanzaart@gmail.com",
      minutesAgo: 8,
    });

    const matches = await flagNearDuplicateVendorRegistration(db as never, { ...SECOND, now: NOW });

    expect(matches.map((m) => m.vendorId)).toEqual(["v-sansa"]);
    const rows = logs();
    expect(rows).toHaveLength(1);
    expect(rows[0].level).toBe("warn");
    expect(rows[0].source).toBe("api/auth/register:near-duplicate");
    const ctx = JSON.parse(rows[0].context);
    expect(ctx.vendorId).toBe("v-sanza");
    expect(ctx.userId).toBe("u-sanza");
    expect(ctx.matches[0]).toMatchObject({
      vendorId: "v-sansa",
      userId: "u-sansa",
      businessName: "Sansa Studio Creations",
    });
  });

  it("writes nothing when there is no look-alike", async () => {
    seed({
      vendorId: "v-other",
      userId: "u-other",
      businessName: "Blue Heron Pottery",
      ownerName: "Ann Marsh",
      email: "ann@blueheron.com",
      minutesAgo: 5,
    });
    expect(await flagNearDuplicateVendorRegistration(db as never, { ...SECOND, now: NOW })).toEqual(
      []
    );
    expect(logs()).toHaveLength(0);
  });

  it("never matches the just-created vendor against itself", async () => {
    // SECOND is already seeded — the only row in the window is its own.
    expect(await flagNearDuplicateVendorRegistration(db as never, { ...SECOND, now: NOW })).toEqual(
      []
    );
    expect(logs()).toHaveLength(0);
  });

  it("ignores a look-alike older than the window", async () => {
    seed({
      vendorId: "v-sansa",
      userId: "u-sansa",
      businessName: "Sansa Studio Creations",
      ownerName: "Douglas Souza",
      email: "sanzaart@gmail.com",
      minutesAgo: 45,
    });
    expect(await flagNearDuplicateVendorRegistration(db as never, { ...SECOND, now: NOW })).toEqual(
      []
    );
  });

  it("ignores an ingested (unclaimed) listing with a similar name", async () => {
    // Ingestion mints unclaimed rows in bursts; those are claim candidates, not
    // a second signup by the same person.
    seed({
      vendorId: "v-ingested",
      userId: "u-placeholder",
      businessName: "Sansa Studio Creations",
      ownerName: "",
      email: "pending+sansa-studio-creations@meetmeatthefair.com",
      minutesAgo: 3,
      selfRegistered: false,
    });
    expect(await flagNearDuplicateVendorRegistration(db as never, { ...SECOND, now: NOW })).toEqual(
      []
    );
  });

  it("is fail-soft: a broken query returns [] and logs the failure instead of throwing", async () => {
    raw.exec("DROP TABLE vendors");
    await expect(
      flagNearDuplicateVendorRegistration(db as never, { ...SECOND, now: NOW })
    ).resolves.toEqual([]);
    expect(logs()[0].message).toMatch(/near-duplicate registration check failed/);
  });
});
