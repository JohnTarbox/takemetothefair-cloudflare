/**
 * REL5 (2026-06-16) — pickUrls now prioritizes unresolved time_to_index_log
 * URLs so the GSC URL Inspection sweep actually measures the URLs we submit to
 * IndexNow. Before this, submitted URLs that hadn't already been inspected were
 * invisible to the inspector, so the reconciler had no PASS verdict to join
 * against and first_crawl_at stayed NULL across all rows.
 *
 * In-memory better-sqlite3 harness (same pattern as event-outbound-clicks.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import { pickUrls } from "../gsc-sweep";

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

const HOST = "https://meetmeatthefair.com";

// Minimal columns pickUrls touches across its tiers.
const SCHEMA_SQL = `
  CREATE TABLE gsc_inspection_state (
    url TEXT PRIMARY KEY,
    last_inspected_at INTEGER,
    last_verdict TEXT,
    last_coverage_state TEXT,
    source TEXT
  );
  CREATE TABLE events (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'APPROVED',
    lifecycle_status TEXT NOT NULL DEFAULT 'SCHEDULED',
    updated_at INTEGER
  );
  CREATE TABLE venues (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE'
  );
  CREATE TABLE blog_posts (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PUBLISHED',
    updated_at INTEGER
  );
  CREATE TABLE time_to_index_log (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    indexnow_submitted_at INTEGER NOT NULL,
    first_crawl_at INTEGER,
    lag_seconds INTEGER,
    computed_at INTEGER NOT NULL
  );
`;

let raw: Database.Database;
let db: TestDb;

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

afterEach(() => {
  raw.close();
});

function seedSubmission(url: string, submittedIso: string, firstCrawlIso: string | null) {
  raw
    .prepare(
      `INSERT INTO time_to_index_log (id, url, indexnow_submitted_at, first_crawl_at, computed_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      crypto.randomUUID(),
      url,
      Math.floor(new Date(submittedIso).getTime() / 1000),
      firstCrawlIso ? Math.floor(new Date(firstCrawlIso).getTime() / 1000) : null,
      Math.floor(new Date(submittedIso).getTime() / 1000)
    );
}

describe("REL5 — pickUrls surfaces unresolved time_to_index_log URLs", () => {
  it("includes submitted-but-unresolved URLs and excludes resolved ones", async () => {
    seedSubmission(`${HOST}/events/unresolved-a`, "2026-06-01T00:00:00Z", null);
    seedSubmission(`${HOST}/events/unresolved-b`, "2026-06-02T00:00:00Z", null);
    // Already resolved — must NOT be re-picked by this tier.
    seedSubmission(`${HOST}/events/resolved`, "2026-05-01T00:00:00Z", "2026-05-03T00:00:00Z");

    const urls = await pickUrls(db as never, 200);
    expect(urls).toContain(`${HOST}/events/unresolved-a`);
    expect(urls).toContain(`${HOST}/events/unresolved-b`);
    expect(urls).not.toContain(`${HOST}/events/resolved`);
  });

  it("skips non-own-host URLs in the log (the inspector resolves a path on our property)", async () => {
    seedSubmission("https://someoneelse.example/events/x", "2026-06-01T00:00:00Z", null);
    seedSubmission(`${HOST}/blog/mine`, "2026-06-01T00:00:00Z", null);

    const urls = await pickUrls(db as never, 200);
    expect(urls).toContain(`${HOST}/blog/mine`);
    expect(urls).not.toContain("https://someoneelse.example/events/x");
  });

  it("respects the batch budget (never returns more than batchSize)", async () => {
    for (let i = 0; i < 10; i++) {
      seedSubmission(`${HOST}/events/e${i}`, `2026-06-0${(i % 9) + 1}T00:00:00Z`, null);
    }
    const urls = await pickUrls(db as never, 4);
    expect(urls.length).toBeLessThanOrEqual(4);
  });
});
