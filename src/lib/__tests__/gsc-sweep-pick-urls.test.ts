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

// Minimal columns pickUrls touches across its tiers. A10/A11 (2026-06-26) added
// per-type guaranteed coverage (venues/promoters/blog/events/vendors) + the
// shared indexable-vendor gate, so the harness now needs those tables/columns.
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
    venue_id TEXT,
    updated_at INTEGER,
    -- OPE-372: the sweep now derives event URLs from the sitemap's gate, which
    -- reads these three. Defaults keep every pre-existing fixture in this file
    -- eligible (completeness 80 clears the sitemap's 40 floor, series_id NULL
    -- means "standalone" → /events/<slug>, the shape these tests assert).
    completeness_score INTEGER DEFAULT 80,
    start_date INTEGER DEFAULT 1790000000,
    end_date INTEGER,
    series_id TEXT
  );
  CREATE TABLE event_series (
    id TEXT PRIMARY KEY,
    canonical_slug TEXT NOT NULL
  );
  CREATE TABLE venues (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    city TEXT,
    state TEXT,
    updated_at INTEGER
  );
  CREATE TABLE promoters (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    updated_at INTEGER
  );
  CREATE TABLE vendors (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    updated_at INTEGER,
    business_name TEXT,
    display_name TEXT,
    description TEXT,
    website TEXT,
    social_links TEXT,
    city TEXT,
    state TEXT,
    address TEXT,
    enhanced_profile INTEGER NOT NULL DEFAULT 0,
    domain_hijacked INTEGER NOT NULL DEFAULT 0,
    deleted_at INTEGER,
    alias_of_vendor_id TEXT,
    role TEXT,
    display_override_permitted INTEGER NOT NULL DEFAULT 0,
    display_mode TEXT,
    brand_parent_vendor_id TEXT,
    operator_parent_vendor_id TEXT,
    default_child_display TEXT
  );
  CREATE TABLE event_vendors (
    id TEXT PRIMARY KEY,
    vendor_id TEXT NOT NULL,
    event_id TEXT NOT NULL
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
  -- OPE-567 follow-up: Tier 0 re-inspects URLs carrying an open ERROR row.
  -- The harness builds its schema from inline CREATE TABLE rather than from
  -- migrations, so a new table pickUrls reads must be added here too or every
  -- test in the file dies on "no such table" (reference_d1_and_migration_gotchas).
  CREATE TABLE health_issues (
    id TEXT PRIMARY KEY,
    fingerprint TEXT,
    source TEXT NOT NULL,
    issue_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    url TEXT,
    message TEXT,
    first_detected_at INTEGER NOT NULL,
    last_detected_at INTEGER NOT NULL,
    resolved_at INTEGER,
    resolution_reason TEXT,
    last_reverified_at INTEGER,
    snoozed_until INTEGER
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

/** A published, sitemap-eligible standalone event (OPE-372 canonical set). */
function seedEvent(id: string, slug: string) {
  raw.prepare(`INSERT INTO events (id, slug) VALUES (?, ?)`).run(id, slug);
}

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
    // OPE-372: `unresolved-a`/`-b` must correspond to PUBLISHED events now —
    // the sweep only inspects event URLs the sitemap advertises.
    //
    // COVERAGE NOTE, stated rather than glossed: `resolved` is deliberately left
    // WITHOUT an events row, so two independent filters now exclude it (the
    // tier's own `first_crawl_at IS NULL` gate, and the OPE-372 canonical
    // filter). This assertion therefore no longer isolates the former. It can't:
    // any event canonical enough to reach Tier 2c is also eligible for the
    // guaranteed per-type sample, which would pick it regardless of crawl state.
    // Isolating that gate needs a direct test of the tier rather than of
    // `pickUrls`; noted in the PR as a real gap, not a resolved one.
    seedEvent("u-a", "unresolved-a");
    seedEvent("u-b", "unresolved-b");
    seedSubmission(`${HOST}/events/unresolved-a`, "2026-06-01T00:00:00Z", null);
    seedSubmission(`${HOST}/events/unresolved-b`, "2026-06-02T00:00:00Z", null);
    // Already resolved — must NOT be re-picked by this tier.
    seedSubmission(`${HOST}/events/resolved`, "2026-05-01T00:00:00Z", "2026-05-03T00:00:00Z");

    const urls = await pickUrls(db as never, 200);
    expect(urls).toContain(`${HOST}/events/unresolved-a`);
    expect(urls).toContain(`${HOST}/events/unresolved-b`);
    expect(urls).not.toContain(`${HOST}/events/resolved`);
  });

  it("skips a submitted event URL we no longer publish (OPE-372)", async () => {
    // The behaviour change made explicit rather than incidental. A URL sitting
    // in time_to_index_log with no published event behind it can only ever come
    // back "not indexed", and filing that as a site-health defect is the exact
    // noise OPE-372 removed. Its time-to-index is meaningless anyway — we are
    // not advertising the page.
    seedSubmission(`${HOST}/events/withdrawn-event`, "2026-06-01T00:00:00Z", null);

    const urls = await pickUrls(db as never, 200);
    expect(urls).not.toContain(`${HOST}/events/withdrawn-event`);
  });

  it("skips non-own-host URLs in the log (the inspector resolves a path on our property)", async () => {
    seedSubmission("https://someoneelse.example/events/x", "2026-06-01T00:00:00Z", null);
    seedSubmission(`${HOST}/blog/mine`, "2026-06-01T00:00:00Z", null);

    const urls = await pickUrls(db as never, 200);
    expect(urls).toContain(`${HOST}/blog/mine`);
    expect(urls).not.toContain("https://someoneelse.example/events/x");
  });

  it("respects the filler budget (no entities seeded → guaranteed set empty, filler capped at batchSize)", async () => {
    for (let i = 0; i < 10; i++) {
      seedSubmission(`${HOST}/events/e${i}`, `2026-06-0${(i % 9) + 1}T00:00:00Z`, null);
    }
    const urls = await pickUrls(db as never, 4);
    expect(urls.length).toBeLessThanOrEqual(4);
  });
});

describe("A10/A11 — per-page-type guaranteed coverage", () => {
  it("includes a venue, promoter, blog, event AND indexable vendor each run", async () => {
    raw
      .prepare(
        `INSERT INTO events (id, slug, status, lifecycle_status) VALUES (?, ?, 'APPROVED', 'SCHEDULED')`
      )
      .run("e1", "an-event");
    raw
      .prepare(
        `INSERT INTO venues (id, slug, status, city, state) VALUES (?, ?, 'ACTIVE', 'Skowhegan', 'ME')`
      )
      .run("v1", "a-venue");
    raw.prepare(`INSERT INTO promoters (id, slug) VALUES (?, ?)`).run("p1", "a-promoter");
    raw
      .prepare(`INSERT INTO blog_posts (id, slug, status) VALUES (?, ?, 'PUBLISHED')`)
      .run("b1", "a-post");
    // An indexable vendor: enhanced_profile=1, not deleted/hijacked/aliased.
    raw
      .prepare(
        `INSERT INTO vendors (id, slug, enhanced_profile, domain_hijacked, deleted_at, alias_of_vendor_id, role)
         VALUES (?, ?, 1, 0, NULL, NULL, 'INDEPENDENT')`
      )
      .run("vd1", "a-vendor");

    const urls = await pickUrls(db as never, 200);
    expect(urls).toContain(`${HOST}/venues/a-venue`);
    expect(urls).toContain(`${HOST}/promoters/a-promoter`);
    expect(urls).toContain(`${HOST}/blog/a-post`);
    expect(urls).toContain(`${HOST}/events/an-event`);
    expect(urls).toContain(`${HOST}/vendors/a-vendor`);
  });

  it("excludes a non-indexable vendor (soft-deleted) from the sample", async () => {
    raw
      .prepare(
        `INSERT INTO vendors (id, slug, enhanced_profile, domain_hijacked, deleted_at, role)
         VALUES (?, ?, 1, 0, 1730000000, 'INDEPENDENT')`
      )
      .run("vd-del", "deleted-vendor");

    const urls = await pickUrls(db as never, 200);
    expect(urls).not.toContain(`${HOST}/vendors/deleted-vendor`);
  });

  // OPE-91 regression: with the default batchSize=8 and a FULL Tier-1 stale
  // backlog (8 non-OK event rows), the old `[...picked].slice(0, batchSize)`
  // discarded every per-type URL — blog/vendor/venue/promoter were never
  // inspected, so gsc_inspection_state had 0 blog rows. The guaranteed per-type
  // coverage must survive regardless of how full the Tier-1 filler is.
  it("does NOT truncate per-type coverage when Tier 1 (stale) is full at batchSize=8", async () => {
    // 8 stale (non-OK) event rows — exactly fills the default batch budget.
    // OPE-372: each needs a published event behind it, or the canonical filter
    // drops it and this stops testing what OPE-91 meant it to test.
    for (let i = 0; i < 8; i++) {
      seedEvent(`stale-e${i}`, `stale-${i}`);
      raw
        .prepare(
          `INSERT INTO gsc_inspection_state (url, last_inspected_at, last_verdict) VALUES (?, ?, 'FAIL')`
        )
        .run(`${HOST}/events/stale-${i}`, 1_700_000_000);
    }
    // Published blog posts that MUST still be sampled into the guaranteed set.
    raw
      .prepare(`INSERT INTO blog_posts (id, slug, status) VALUES (?, ?, 'PUBLISHED')`)
      .run("b1", "guaranteed-post-a");
    raw
      .prepare(`INSERT INTO blog_posts (id, slug, status) VALUES (?, ?, 'PUBLISHED')`)
      .run("b2", "guaranteed-post-b");

    const urls = await pickUrls(db as never, 8);
    // Blog coverage survives the full Tier-1 filler (the whole point of OPE-91).
    expect(urls).toContain(`${HOST}/blog/guaranteed-post-a`);
    expect(urls).toContain(`${HOST}/blog/guaranteed-post-b`);
    // And a Tier-1 stale event still made it into the filler budget.
    expect(urls.some((u) => u.startsWith(`${HOST}/events/stale-`))).toBe(true);
  });
});

/**
 * OPE-567 follow-up — Tier 0: a URL with an OPEN ERROR health issue is
 * re-inspected first.
 *
 * Tier 1 re-inspects a non-OK *index* verdict, but `last_verdict` only stores
 * the index half. A page that is indexed perfectly and has BROKEN STRUCTURED
 * DATA reads `PASS` there, so nothing prioritised it and it fell into the
 * general rotation.
 *
 * Measured on prod 2026-08-26: the four open GSC_RICH_RESULT_FAIL rows were all
 * `PASS` / "Submitted and indexed", each with ~1,300 URLs ahead of it in the
 * least-recently-inspected queue — about five months at the default batch size.
 * The OPE-567 staleness rule alone would not have corrected them until January.
 */
function seedOpenIssue(
  url: string,
  severity: string,
  opts: {
    resolved?: boolean;
    source?: string;
    issueType?: string;
    firstDetectedAt?: number;
    lastReverifiedAt?: number | null;
  } = {}
) {
  raw
    .prepare(
      `INSERT INTO health_issues
       (id, fingerprint, source, issue_type, severity, url, message,
        first_detected_at, last_detected_at, resolved_at, last_reverified_at)
       VALUES (?, ?, ?, ?, ?, ?, 'FAIL: Missing field "location"', ?, ?, ?, ?)`
    )
    .run(
      `hi-${url}-${severity}`,
      `fp-${url}`,
      opts.source ?? "GSC_URL_INSPECTION",
      opts.issueType ?? "GSC_RICH_RESULT_FAIL",
      severity,
      url,
      opts.firstDetectedAt ?? 1,
      opts.firstDetectedAt ?? 1,
      opts.resolved ? 2 : null,
      opts.lastReverifiedAt ?? null
    );
}

describe("OPE-567 follow-up — Tier 0 re-inspects URLs with an open ERROR", () => {
  // ⚠️ ISOLATION NOTE, learned the hard way on this very test.
  //
  // The first version of this used a seeded `/events/<slug>` URL — the exact
  // prod shape — and passed with Tier 0 DELETED. A canonical event is picked by
  // the guaranteed per-type slice regardless, so the test proved nothing. It is
  // the same trap the REL5 block above already documents.
  //
  // These use a `/venues/<slug>` URL with NO venue row: the guaranteed slice
  // cannot pick it (no entity), and the OPE-372 canonical filter only rejects
  // `/events/` URLs, so Tier 0 is the ONLY thing that can put it in the result.
  // Deleting Tier 0 now reddens the positive case, which is what makes the three
  // negatives below mean anything.
  it("picks a URL that ONLY an open ERROR row can justify", async () => {
    const url = `${HOST}/venues/ghost-with-open-error`;
    seedOpenIssue(url, "ERROR");
    expect(await pickUrls(db as never, 200)).toContain(url);
  });

  it("does NOT pick a RESOLVED error row", async () => {
    const url = `${HOST}/venues/already-fixed-venue`;
    seedOpenIssue(url, "ERROR", { resolved: true });
    expect(await pickUrls(db as never, 200)).not.toContain(url);
  });

  it("does NOT pick an open INFO row — only ERROR earns a re-inspection", async () => {
    // A downgraded STALE VERDICT row is INFO. It must not consume the tier it
    // was just removed from, or the fix would re-prioritise its own output.
    const url = `${HOST}/venues/downgraded-stale-venue`;
    seedOpenIssue(url, "INFO");
    expect(await pickUrls(db as never, 200)).not.toContain(url);
  });

  it("does NOT pick a GSC_INSPECTION_NON_OK row — that type has its own pass", async () => {
    // Scope matters both ways. `reverifyOpenIssues` already round-robins the
    // NON_OK rows against our own origin; pulling them in here would spend a
    // GSC inspection re-learning what a cheap local fetch already settles, and
    // would move a cursor that pass depends on.
    const url = `${HOST}/venues/non-ok-venue`;
    seedOpenIssue(url, "ERROR", { issueType: "GSC_INSPECTION_NON_OK" });
    expect(await pickUrls(db as never, 200)).not.toContain(url);
  });

  it("runs even though fillerBudget is structurally ZERO — the whole point", async () => {
    // fillerBudget = max(0, batchSize - guaranteed.size), and `guaranteed` is
    // five per-type samples of PER_TYPE=10. Measured on prod 2026-08-26, every
    // type has far more than 10 rows, so guaranteed.size is 50 on every run
    // against a batch_size the MCP tool caps at 50 — the budget is ALWAYS 0 and
    // every filler tier is unreachable. Tier 0 must not draw from it.
    //
    // ⚠️ This must REPRODUCE that, not just assert around it. An earlier version
    // seeded nothing and called pickUrls(db, 1): with an empty `guaranteed`,
    // fillerBudget was 1, so a Tier 0 wired to fillerBudget passed too and the
    // mutant survived. Seeding 10 venues makes guaranteed.size >= batchSize,
    // exactly as in prod.
    for (let i = 0; i < 10; i++) {
      raw
        .prepare(`INSERT INTO venues (id, slug, status) VALUES (?, ?, 'ACTIVE')`)
        .run(`v-fill-${i}`, `filler-venue-${i}`);
    }
    const url = `${HOST}/venues/reachable-on-a-zero-budget`;
    seedOpenIssue(url, "ERROR");
    expect(await pickUrls(db as never, 1)).toContain(url);
  });

  it("caps at 5 per run, so it cannot own the sweep", async () => {
    // The systemic case: many open errors at once. Uncapped, this tier would
    // spend the whole GSC budget re-checking errors and nothing else.
    for (let i = 0; i < 40; i++) seedOpenIssue(`${HOST}/venues/err-${i}`, "ERROR");
    const picked = await pickUrls(db as never, 8);
    const fromTier0 = picked.filter((u) => u.includes("/venues/err-"));
    expect(fromTier0).toHaveLength(5);
  });

  it("puts its URLs FIRST — the run is killed before it finishes", async () => {
    // runSweep's inspection loop has no time budget and `guaranteed` alone is
    // 50 URLs at ~3-5s each, so the platform kills the run partway. Position in
    // this array decides what is actually inspected. Tier 0 adding into an
    // insertion-ordered Set put it behind all 50 rotation samples, while still
    // stamping its cursor — attempted, never looked at.
    for (let i = 0; i < 10; i++) {
      raw
        .prepare(`INSERT INTO venues (id, slug, status) VALUES (?, ?, 'ACTIVE')`)
        .run(`v-ord-${i}`, `ordering-venue-${i}`);
    }
    const url = `${HOST}/venues/must-be-inspected-first`;
    seedOpenIssue(url, "ERROR");
    const picked = await pickUrls(db as never, 8);
    expect(picked[0]).toBe(url);
  });

  it("returns no duplicates — Tier 0 URLs are in `guaranteed` too", async () => {
    const url = `${HOST}/venues/dupe-check`;
    seedOpenIssue(url, "ERROR");
    const picked = await pickUrls(db as never, 8);
    expect(picked.filter((u) => u === url)).toHaveLength(1);
    expect(new Set(picked).size).toBe(picked.length);
  });

  it("honours batch_size=0 — maintenance only, no GSC spend", async () => {
    // The MCP tool documents 0 as "run ONLY the maintenance passes, no quota
    // spend at all". A tier with its own budget must not quietly break that.
    const url = `${HOST}/venues/must-not-be-inspected`;
    seedOpenIssue(url, "ERROR");
    expect(await pickUrls(db as never, 0)).not.toContain(url);
  });

  it("does not stamp the cursor when batch_size=0", async () => {
    // Stamping without inspecting would advance the rotation for work never
    // done — the exact defect this PR exists to fix, in miniature.
    const url = `${HOST}/venues/unstamped`;
    seedOpenIssue(url, "ERROR");
    await pickUrls(db as never, 0);
    const row = raw
      .prepare("SELECT last_reverified_at AS c FROM health_issues WHERE url = ?")
      .get(url) as { c: number | null };
    expect(row.c).toBeNull();
  });

  it("rotates: a second run picks rows the first run did not", async () => {
    // The stamp is what makes the cap safe. Without advancing the cursor, the
    // same oldest N rows are re-picked every night and the rest starve — the
    // OPE-382 head-of-line bug, rebuilt on a new tier.
    for (let i = 0; i < 40; i++) seedOpenIssue(`${HOST}/venues/rot-${i}`, "ERROR");
    const t0 = new Date(1_000_000);
    const first = (await pickUrls(db as never, 8, undefined, t0)).filter((u) =>
      u.includes("/venues/rot-")
    );
    const second = (await pickUrls(db as never, 8, undefined, t0)).filter((u) =>
      u.includes("/venues/rot-")
    );
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
    // No overlap: every row the first run touched was stamped and sorts last.
    expect(second.filter((u) => first.includes(u))).toEqual([]);
  });
});
