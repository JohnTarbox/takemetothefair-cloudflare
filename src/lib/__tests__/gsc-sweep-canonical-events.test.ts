/**
 * OPE-372 — the sweep must only ever inspect event URLs the sitemap publishes.
 *
 * 81 of 318 open `GSC_INSPECTION_NON_OK` rows (25%) were the sweep asking
 * Google about URLs we deliberately do not advertise, then filing Google's
 * correct answer as our defect — regenerated daily, so draining the queue by
 * hand could never win.
 *
 * The property under test is NOT "the URL builder emits a nested path" — that
 * is one line and it would pass while the bug stayed alive. It is "no
 * non-canonical /events/ URL can escape `pickUrls`, from ANY tier", because
 * three of the six tiers read URLs back out of `gsc_inspection_state` and
 * `time_to_index_log`, both of which are full of the legacy flat URLs written
 * before this fix. A fix wired into the constructors alone leaves those tiers
 * recycling the old URLs forever.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";

// Vendor selection is irrelevant here and its gate is raw SQL across three
// tables; stubbing it keeps this test about events.
vi.mock("@/lib/sitemap/indexable-vendors", () => ({
  getIndexableVendorRows: async () => [],
}));

const { pickUrls, resolveNonCanonicalEventIssues } = await import("../gsc-sweep");
const { canonicalEventPath, collectCanonicalEventPaths, getIndexableEventRows } =
  await import("../sitemap/indexable-events");

const HOST = "https://meetmeatthefair.com";

const SCHEMA_SQL = `
  CREATE TABLE events (
    id TEXT PRIMARY KEY, slug TEXT, status TEXT, lifecycle_status TEXT,
    completeness_score INTEGER, start_date INTEGER, end_date INTEGER,
    updated_at INTEGER, series_id TEXT
  );
  CREATE TABLE event_series (id TEXT PRIMARY KEY, canonical_slug TEXT);
  CREATE TABLE venues (id TEXT PRIMARY KEY, slug TEXT, status TEXT);
  CREATE TABLE promoters (id TEXT PRIMARY KEY, slug TEXT);
  CREATE TABLE blog_posts (id TEXT PRIMARY KEY, slug TEXT, status TEXT, updated_at INTEGER);
  CREATE TABLE gsc_inspection_state (
    url TEXT PRIMARY KEY, last_inspected_at INTEGER, last_verdict TEXT
  );
  CREATE TABLE time_to_index_log (
    id TEXT PRIMARY KEY, url TEXT, first_crawl_at INTEGER, indexnow_submitted_at INTEGER
  );
  CREATE TABLE health_issues (
    id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE, source TEXT, issue_type TEXT,
    severity TEXT, url TEXT, message TEXT, first_detected_at INTEGER,
    last_detected_at INTEGER, resolved_at INTEGER, resolution_reason TEXT
  );
`;

let raw: Database.Database;
let db: any;

const sec = (d: string) => Math.floor(new Date(d).getTime() / 1000);

/** A series occurrence: canonical URL is /events/<series>/<year>. */
function seedOccurrence(id: string, slug: string, seriesSlug: string, year: number) {
  raw
    .prepare("INSERT OR IGNORE INTO event_series (id, canonical_slug) VALUES (?,?)")
    .run(`series-${seriesSlug}`, seriesSlug);
  raw
    .prepare(
      `INSERT INTO events (id, slug, status, lifecycle_status, completeness_score,
       start_date, end_date, updated_at, series_id) VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id,
      slug,
      "APPROVED",
      "SCHEDULED",
      80,
      sec(`${year}-06-01`),
      sec(`${year}-06-03`),
      sec("2026-08-01"),
      `series-${seriesSlug}`
    );
}

function seedStandalone(id: string, slug: string, completeness = 80) {
  raw
    .prepare(
      `INSERT INTO events (id, slug, status, lifecycle_status, completeness_score,
       start_date, end_date, updated_at, series_id) VALUES (?,?,?,?,?,?,?,?,NULL)`
    )
    .run(
      id,
      slug,
      "APPROVED",
      "SCHEDULED",
      completeness,
      sec("2026-09-01"),
      sec("2026-09-02"),
      sec("2026-08-01")
    );
}

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

describe("canonical event URL rule (OPE-372)", () => {
  it("routes a series occurrence to the nested canonical, not the flat slug", () => {
    // The exact shape from the ticket: /events/augusta-boat-show-2026 was the
    // flat URL we inspected; /events/augusta-boat-show/2026 is what we publish.
    const path = canonicalEventPath({
      slug: "augusta-boat-show-2026",
      seriesSlug: "augusta-boat-show",
      startDate: new Date("2026-06-01"),
    });
    expect(path).toBe("/events/augusta-boat-show/2026");
  });

  it("leaves a standalone event on its own slug", () => {
    expect(
      canonicalEventPath({
        slug: "one-off-fair",
        seriesSlug: null,
        startDate: new Date("2026-09-01"),
      })
    ).toBe("/events/one-off-fair");
  });

  it("includes the series landing alongside each occurrence", () => {
    const paths = collectCanonicalEventPaths([
      {
        slug: "x-2026",
        seriesSlug: "x",
        startDate: new Date("2026-06-01"),
        endDate: null,
        updatedAt: null,
      },
      {
        slug: "x-2027",
        seriesSlug: "x",
        startDate: new Date("2027-06-01"),
        endDate: null,
        updatedAt: null,
      },
    ]);
    expect([...paths].sort()).toEqual(["/events/x", "/events/x/2026", "/events/x/2027"]);
  });
});

describe("the sitemap gate is the sweep's gate (OPE-372)", () => {
  it("excludes events the sitemap withholds for low completeness", async () => {
    seedStandalone("e-good", "good-fair", 80);
    seedStandalone("e-thin", "thin-fair", 10); // below SITEMAP_MIN_COMPLETENESS (40)
    const rows = await getIndexableEventRows(db);
    expect(rows.map((r: any) => r.slug)).toEqual(["good-fair"]);
  });
});

describe("pickUrls emits canonical event URLs only (OPE-372)", () => {
  it("never returns a legacy flat URL that is sitting in gsc_inspection_state", async () => {
    // THE regression guard. Tier 1 selects stale non-OK URLs straight out of
    // this table, so the legacy row below is exactly what kept refilling the
    // queue after the constructors were fixed.
    seedOccurrence("e1", "augusta-boat-show-2026", "augusta-boat-show", 2026);
    raw
      .prepare(
        "INSERT INTO gsc_inspection_state (url, last_inspected_at, last_verdict) VALUES (?,?,?)"
      )
      .run(`${HOST}/events/augusta-boat-show-2026`, sec("2026-08-01"), "FAIL");

    const urls = await pickUrls(db, 50);

    expect(urls).not.toContain(`${HOST}/events/augusta-boat-show-2026`);
    expect(urls).toContain(`${HOST}/events/augusta-boat-show/2026`);
  });

  it("every /events/ URL it returns is one the sitemap publishes", async () => {
    seedOccurrence("e1", "augusta-boat-show-2026", "augusta-boat-show", 2026);
    seedOccurrence("e2", "maine-cannabis-expo-2026", "maine-cannabis-expo", 2026);
    seedStandalone("e3", "one-off-fair");
    seedStandalone("e4", "thin-fair", 5); // withheld by the sitemap
    // Legacy junk in both recycling sources.
    raw
      .prepare(
        "INSERT INTO gsc_inspection_state (url, last_inspected_at, last_verdict) VALUES (?,?,?)"
      )
      .run(`${HOST}/events/maine-cannabis-expo-2026`, sec("2026-08-01"), "NEUTRAL");
    raw
      .prepare(
        "INSERT INTO time_to_index_log (id, url, first_crawl_at, indexnow_submitted_at) VALUES (?,?,NULL,?)"
      )
      .run("t1", `${HOST}/events/thin-fair`, sec("2026-07-01"));

    const urls = await pickUrls(db, 50);
    const published = new Set(
      [...collectCanonicalEventPaths(await getIndexableEventRows(db))].map((p) => `${HOST}${p}`)
    );

    const eventUrls = urls.filter((u: string) => u.startsWith(`${HOST}/events/`));
    expect(eventUrls.length).toBeGreaterThan(0);
    for (const u of eventUrls) expect(published).toContain(u);
  });
});

describe("resolveNonCanonicalEventIssues (OPE-372)", () => {
  const openIssue = (id: string, url: string, issueType = "GSC_INSPECTION_NON_OK") =>
    raw
      .prepare(
        `INSERT INTO health_issues (id, fingerprint, source, issue_type, severity, url,
         first_detected_at, last_detected_at, resolved_at) VALUES (?,?,?,?,?,?,?,?,NULL)`
      )
      .run(id, `fp-${id}`, "GSC_URL_INSPECTION", issueType, "warning", url, 1, 1);

  it("withdraws issues raised against URLs we never published", async () => {
    seedOccurrence("e1", "augusta-boat-show-2026", "augusta-boat-show", 2026);
    openIssue("i1", `${HOST}/events/augusta-boat-show-2026`);

    const canonical = new Set(
      [...collectCanonicalEventPaths(await getIndexableEventRows(db))].map((p) => `${HOST}${p}`)
    );
    const n = await resolveNonCanonicalEventIssues(db, canonical, new Date());

    expect(n).toBe(1);
    const row: any = raw
      .prepare("SELECT resolved_at, message FROM health_issues WHERE id='i1'")
      .get();
    expect(row.resolved_at).not.toBeNull();
    expect(row.message).toContain("OPE-372");
  });

  it("leaves a genuinely-failing CANONICAL event issue open", async () => {
    // #761 shipped a resolve loop that closed every GSC issue indiscriminately.
    // This is the guard against repeating that: real signal must survive.
    seedOccurrence("e1", "augusta-boat-show-2026", "augusta-boat-show", 2026);
    openIssue("i-real", `${HOST}/events/augusta-boat-show/2026`);

    const canonical = new Set(
      [...collectCanonicalEventPaths(await getIndexableEventRows(db))].map((p) => `${HOST}${p}`)
    );
    const n = await resolveNonCanonicalEventIssues(db, canonical, new Date());

    expect(n).toBe(0);
    const row: any = raw.prepare("SELECT resolved_at FROM health_issues WHERE id='i-real'").get();
    expect(row.resolved_at).toBeNull();
  });

  it("never touches non-event issues, whatever their URL", async () => {
    seedStandalone("e1", "one-off-fair");
    openIssue("i-vendor", `${HOST}/vendors/some-vendor`);
    openIssue("i-blog", `${HOST}/blog/some-post`);

    const canonical = new Set(
      [...collectCanonicalEventPaths(await getIndexableEventRows(db))].map((p) => `${HOST}${p}`)
    );
    const n = await resolveNonCanonicalEventIssues(db, canonical, new Date());

    expect(n).toBe(0);
  });

  it("ignores a different issue_type on a non-canonical event URL", async () => {
    // Scoped by issue_type as well as URL — a rich-result failure is a
    // different question and is not ours to close.
    seedOccurrence("e1", "augusta-boat-show-2026", "augusta-boat-show", 2026);
    openIssue("i-rich", `${HOST}/events/augusta-boat-show-2026`, "GSC_RICH_RESULT_FAIL");

    const canonical = new Set(
      [...collectCanonicalEventPaths(await getIndexableEventRows(db))].map((p) => `${HOST}${p}`)
    );
    expect(await resolveNonCanonicalEventIssues(db, canonical, new Date())).toBe(0);
  });
});
