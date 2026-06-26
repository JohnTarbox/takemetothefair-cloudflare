/**
 * A9 (2026-06-26) — request sampling gate + writer.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import { shouldSample, writeRequestSample, REQUEST_SAMPLE_RATE } from "../request-sampling";

describe("shouldSample", () => {
  it("captures below the rate, skips at/above it", () => {
    expect(shouldSample(0)).toBe(true);
    expect(shouldSample(REQUEST_SAMPLE_RATE - 0.0001)).toBe(true);
    expect(shouldSample(REQUEST_SAMPLE_RATE)).toBe(false);
    expect(shouldSample(0.99)).toBe(false);
  });
});

const SCHEMA_SQL = `
  CREATE TABLE request_samples (
    id TEXT PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    path TEXT,
    method TEXT,
    user_agent TEXT,
    ip TEXT,
    asn INTEGER,
    as_organization TEXT,
    country TEXT,
    referer TEXT,
    ray TEXT
  );
`;

let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
});
afterEach(() => raw.close());

function rowCount(): number {
  return (raw.prepare(`SELECT COUNT(*) AS n FROM request_samples`).get() as { n: number }).n;
}

describe("writeRequestSample", () => {
  it("inserts a sampled row with UA/IP/ASN/path", async () => {
    await writeRequestSample(
      db as never,
      {
        path: "/events/cheshire-fair",
        method: "GET",
        userAgent: "BotCrawler/1.0",
        ip: "203.0.113.7",
        asn: 14618,
        asOrganization: "AMAZON-AES",
        country: "US",
        referer: null,
        ray: "abc-IAD",
      },
      { pruneRoll: 0.5 } // above PRUNE_PROBABILITY → no prune
    );
    const r = raw.prepare(`SELECT * FROM request_samples`).get() as Record<string, unknown>;
    expect(rowCount()).toBe(1);
    expect(r.user_agent).toBe("BotCrawler/1.0");
    expect(r.asn).toBe(14618);
    expect(r.as_organization).toBe("AMAZON-AES");
    expect(r.path).toBe("/events/cheshire-fair");
  });

  it("prunes rows older than the retention window when the prune roll fires", async () => {
    const now = new Date("2026-06-26T00:00:00Z");
    // An old row (90 days ago) seeded directly.
    raw
      .prepare(`INSERT INTO request_samples (id, timestamp) VALUES ('old', ?)`)
      .run(Math.floor(new Date("2026-03-28T00:00:00Z").getTime() / 1000));
    // A recent row (yesterday).
    raw
      .prepare(`INSERT INTO request_samples (id, timestamp) VALUES ('recent', ?)`)
      .run(Math.floor(new Date("2026-06-25T00:00:00Z").getTime() / 1000));

    await writeRequestSample(db as never, { path: "/x" }, { now, pruneRoll: 0 }); // prune fires

    const ids = (
      raw.prepare(`SELECT id FROM request_samples ORDER BY id`).all() as { id: string }[]
    ).map((r) => r.id);
    // The 90-day-old row is gone; the recent row + the just-inserted one remain.
    expect(ids).not.toContain("old");
    expect(ids).toContain("recent");
    expect(rowCount()).toBe(2);
  });

  it("never throws (best-effort) — a bad db is swallowed", async () => {
    const brokenDb = {
      insert: () => {
        throw new Error("d1 down");
      },
    };
    await expect(writeRequestSample(brokenDb as never, { path: "/x" })).resolves.toBeUndefined();
  });
});
