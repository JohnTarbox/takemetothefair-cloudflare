/**
 * OPE-244 — the resolve loop must only auto-close rows from the sources
 * `collectFreshIssues` actually re-collects. Before this fix, a GSC_URL_INSPECTION
 * rich-result failure (produced by the separate gsc-sweep path) was auto-resolved
 * on every refresh because it's never in the fresh batch — so a page failing in
 * Google read as "resolved" within 24h. A10 rich-results-signal-discarded, again.
 *
 * Real in-memory better-sqlite3 (like fault-health.test.ts) so the actual scoped
 * WHERE runs; the three integration clients are mocked to yield an EMPTY fresh
 * batch (the worst case — everything open would be "absent" and, pre-fix, closed).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/bing-webmaster", () => ({
  getSiteScanIssues: vi.fn(async () => []),
  getSitemaps: vi.fn(async () => []),
}));
vi.mock("@/lib/search-console", () => ({
  getSitemapStatus: vi.fn(async () => ({ sitemaps: [] })),
}));

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import { healthIssues } from "../db/schema";
import { refreshIssues } from "../site-health";

const SCHEMA_SQL = `
  CREATE TABLE health_issues (
    id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,
    issue_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    url TEXT,
    message TEXT,
    first_detected_at INTEGER NOT NULL,
    last_detected_at INTEGER NOT NULL,
    resolved_at INTEGER
  );
  CREATE TABLE health_issue_snoozes (
    fingerprint TEXT PRIMARY KEY,
    snoozed_until INTEGER NOT NULL,
    snoozed_by TEXT NOT NULL
  );
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
const past = new Date("2026-07-01T00:00:00Z");

beforeEach(async () => {
  const sqlite = new Database(":memory:");
  sqlite.exec(SCHEMA_SQL);
  db = drizzle(sqlite, { schema });
  // A GSC rich-result failure (owned by gsc-sweep; never in collectFreshIssues)
  await db.insert(healthIssues).values({
    id: "gsc-rr",
    fingerprint: "fp-gsc-urlinspection",
    source: "GSC_URL_INSPECTION",
    issueType: "GSC_RICH_RESULT_FAIL",
    severity: "ERROR",
    url: "https://meetmeatthefair.com/events/new-hampshire-outdoor-expo",
    message: 'Missing field "location"',
    firstDetectedAt: past,
    lastDetectedAt: past,
    resolvedAt: null,
  });
  // A collected-source row that IS legitimately absent from the (empty) batch.
  await db.insert(healthIssues).values({
    id: "bing-scan",
    fingerprint: "fp-bing-scan",
    source: "BING_SCAN",
    issueType: "SOME_SCAN_ISSUE",
    severity: "WARNING",
    url: null,
    message: "x",
    firstDetectedAt: past,
    lastDetectedAt: past,
    resolvedAt: null,
  });
});

describe("refreshIssues resolve scoping (OPE-244)", () => {
  it("does NOT auto-resolve a GSC_URL_INSPECTION row it never re-collects", async () => {
    await refreshIssues(db, {} as never, {} as never);
    const [gsc] = await db.select().from(healthIssues).where(eq(healthIssues.id, "gsc-rr"));
    expect(gsc.resolvedAt).toBeNull(); // survives — gsc-sweep owns its lifecycle
  });

  it("STILL resolves a collected-source row that's genuinely gone from the batch", async () => {
    await refreshIssues(db, {} as never, {} as never);
    const [bing] = await db.select().from(healthIssues).where(eq(healthIssues.id, "bing-scan"));
    expect(bing.resolvedAt).not.toBeNull(); // BING_SCAN is re-collected; absent = fixed
  });
});
