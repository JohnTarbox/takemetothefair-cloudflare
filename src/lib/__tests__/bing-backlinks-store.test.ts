/**
 * OPE-50 — bing-backlinks-store: CSV parser (pure) + import/read round-trip
 * (better-sqlite3 in-memory). Mirrors the create-occurrence.test.ts harness.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import {
  parseReferringDomainsCsv,
  importReferringDomains,
  getLatestReferringDomains,
} from "../bing-backlinks-store";

const SCHEMA_SQL = `
  CREATE TABLE bing_backlinks (
    id TEXT PRIMARY KEY,
    referring_domain TEXT NOT NULL,
    backlink_count INTEGER NOT NULL,
    snapshot_date TEXT NOT NULL,
    created_at INTEGER
  );
  CREATE UNIQUE INDEX uq_bing_backlinks_domain_snapshot
    ON bing_backlinks (referring_domain, snapshot_date);
  CREATE INDEX idx_bing_backlinks_snapshot_date ON bing_backlinks (snapshot_date);
`;

// The exact BWT export shape: UTF-8 BOM + header + quoted rows, CRLF-terminated.
const SAMPLE_CSV =
  "﻿" +
  ['"Domain","Backlinks Count"', '"https://msn.com","2"', '"https://alcomusa.com","1"'].join(
    "\r\n"
  ) +
  "\r\n";

let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
});
afterEach(() => raw.close());

describe("parseReferringDomainsCsv", () => {
  it("parses the sample CSV to the ground-truth rows", () => {
    expect(parseReferringDomainsCsv(SAMPLE_CSV)).toEqual([
      { domain: "msn.com", count: 2 },
      { domain: "alcomusa.com", count: 1 },
    ]);
  });

  it("normalises scheme, leading www., and trailing slash", () => {
    const csv = [
      '"Domain","Backlinks Count"',
      '"https://www.Example.com/","5"',
      '"http://foo.org","3"',
      '"https://bar.net/path/page","7"',
    ].join("\n");
    expect(parseReferringDomainsCsv(csv)).toEqual([
      { domain: "example.com", count: 5 },
      { domain: "foo.org", count: 3 },
      { domain: "bar.net", count: 7 },
    ]);
  });

  it("skips the header, blank lines, and malformed rows", () => {
    const csv = [
      '"Domain","Backlinks Count"',
      "",
      '"https://good.com","4"',
      '"https://","9"', // no host after normalisation
      '"https://bad.com","notanumber"',
      "   ",
    ].join("\r\n");
    expect(parseReferringDomainsCsv(csv)).toEqual([{ domain: "good.com", count: 4 }]);
  });

  it("returns [] for empty input", () => {
    expect(parseReferringDomainsCsv("")).toEqual([]);
    expect(parseReferringDomainsCsv('"Domain","Backlinks Count"\n')).toEqual([]);
  });
});

describe("importReferringDomains + getLatestReferringDomains", () => {
  it("round-trips a snapshot, sorted by count desc then domain asc", async () => {
    const rows = parseReferringDomainsCsv(SAMPLE_CSV);
    const res = await importReferringDomains(db as never, rows, "2026-07-02");
    expect(res).toEqual({ imported: 2 });

    const latest = await getLatestReferringDomains(db as never);
    expect(latest).toEqual([
      { domain: "msn.com", count: 2, snapshotDate: "2026-07-02" },
      { domain: "alcomusa.com", count: 1, snapshotDate: "2026-07-02" },
    ]);
  });

  it("is idempotent — re-importing the same snapshot updates in place, not duplicates", async () => {
    await importReferringDomains(db as never, [{ domain: "msn.com", count: 2 }], "2026-07-02");
    // Re-import same snapshot with an updated count.
    await importReferringDomains(db as never, [{ domain: "msn.com", count: 9 }], "2026-07-02");

    const total = raw.prepare(`SELECT COUNT(*) AS n FROM bing_backlinks`).get() as { n: number };
    expect(total.n).toBe(1);

    const latest = await getLatestReferringDomains(db as never);
    expect(latest).toEqual([{ domain: "msn.com", count: 9, snapshotDate: "2026-07-02" }]);
  });

  it("returns only the most-recent snapshot", async () => {
    await importReferringDomains(
      db as never,
      [
        { domain: "old-a.com", count: 5 },
        { domain: "old-b.com", count: 1 },
      ],
      "2026-07-01"
    );
    await importReferringDomains(
      db as never,
      [
        { domain: "new-a.com", count: 3 },
        { domain: "new-b.com", count: 8 },
      ],
      "2026-07-02"
    );

    const latest = await getLatestReferringDomains(db as never);
    expect(latest).toEqual([
      { domain: "new-b.com", count: 8, snapshotDate: "2026-07-02" },
      { domain: "new-a.com", count: 3, snapshotDate: "2026-07-02" },
    ]);
  });

  it("returns [] when nothing imported", async () => {
    expect(await getLatestReferringDomains(db as never)).toEqual([]);
  });

  it("chunks a large import under the D1 param cap and imports all rows", async () => {
    const many = Array.from({ length: 95 }, (_, i) => ({
      domain: `d${String(i).padStart(3, "0")}.com`,
      count: i,
    }));
    const res = await importReferringDomains(db as never, many, "2026-07-03");
    expect(res).toEqual({ imported: 95 });
    const total = raw.prepare(`SELECT COUNT(*) AS n FROM bing_backlinks`).get() as { n: number };
    expect(total.n).toBe(95);
  });
});
