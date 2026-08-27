/**
 * OPE-382 — the re-verify pass must reach the TAIL of the open queue, not
 * re-fetch its head forever.
 *
 * Production, 2026-08-13: 159 open GSC_INSPECTION_NON_OK rows, of which 90 were
 * classes our origin can never settle. The pass ordered by `last_detected_at`
 * (a property of the SCAN) and took the oldest 40 — of which 33 were
 * undecidable. The two 5xx rows the ticket was filed about sat at ranks 80 and
 * 107 and had never been fetched once, despite serving HTTP 200.
 *
 * Real in-memory better-sqlite3, deliberately: the defect lived in the ORDER BY
 * and the WHERE, so a mocked query builder would have asserted nothing. These
 * tests only pass if the actual SQL selects the actual rows.
 */
import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq, isNull } from "drizzle-orm";
import * as schema from "../db/schema";
import { healthIssues } from "../db/schema";
import { reverifyOpenIssues } from "../gsc-sweep";
import {
  classifyMessage,
  LOCALLY_DECIDABLE_SQL_PROBES,
  LOCALLY_DECIDABLE_MESSAGES,
} from "../site-health-reverify";

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
    resolved_at INTEGER,
    resolution_reason TEXT,
    -- OPE-382 (drizzle/0188) — re-verify's own cursor.
    last_reverified_at INTEGER
  );
`;

function makeDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(SCHEMA_SQL);
  return drizzle(sqlite, { schema });
}

/**
 * The better-sqlite3 driver runs these queries identically to D1 — that is the
 * point of using it — but the two Drizzle instances are not nominally
 * assignable. The sibling suites widen the whole variable to `any`; this keeps
 * the cast local and named, so seeding still gets real types and only the call
 * boundary is loosened.
 */
const asDb = (db: ReturnType<typeof makeDb>) =>
  db as unknown as Parameters<typeof reverifyOpenIssues>[0];

/** `n` open rows, oldest-scanned first, all decidable-noindex unless overridden. */
function seed(
  db: ReturnType<typeof makeDb>,
  rows: { id: string; message: string; detectedAt: number }[]
) {
  for (const r of rows) {
    db.insert(healthIssues)
      .values({
        id: r.id,
        fingerprint: `fp-${r.id}`,
        source: "GSC",
        issueType: "GSC_INSPECTION_NON_OK",
        severity: "WARN",
        url: `https://meetmeatthefair.com/blog/${r.id}`,
        message: r.message,
        firstDetectedAt: new Date(r.detectedAt * 1000),
        lastDetectedAt: new Date(r.detectedAt * 1000),
      })
      .run();
  }
}

const emptyResult = () => ({
  inspected: 0,
  newIssues: 0,
  resolvedIssues: 0,
  skipped: 0,
  deadlineSkipped: 0,
  errors: [],
  resolvedByReason: {},
});

describe("OPE-382 — decidability filter", () => {
  /**
   * NOTE ON WHAT THIS ASSERTS, because the obvious assertion is vacuous.
   *
   * Counting fetches proves nothing: `reverifyHealthIssue` classifies the
   * message and returns `decidable: false` BEFORE issuing any request, so
   * undecidable rows are never fetched whether or not the SQL filters them. A
   * fetch-count test passes with the filter deleted — verified by mutation.
   *
   * The filter's actual job is to stop undecidable rows consuming BATCH SLOTS.
   * In production 90 of 159 open rows were undecidable and clustered at the old
   * end of the sort, so they occupied 33 of every 40-row batch while decidable
   * rows behind them starved. That is what this pins.
   */
  it("does not let undecidable rows consume the batch that decidable rows need", async () => {
    const db = makeDb();
    seed(db, [
      // Older, and therefore first under ANY last_detected_at ordering.
      { id: "unknown", message: "URL is unknown to Google", detectedAt: 1000 },
      { id: "crawled", message: "Crawled - currently not indexed", detectedAt: 1001 },
      { id: "discovered", message: "Discovered - currently not indexed", detectedAt: 1002 },
      // Newer, decidable, and serving 200 — these should close.
      { id: "noindex-a", message: "Excluded by ‘noindex’ tag", detectedAt: 9998 },
      { id: "noindex-b", message: "Excluded by ‘noindex’ tag", detectedAt: 9999 },
    ]);

    const fetchImpl = vi.fn(
      async () => new Response("<html><head></head><body>ok</body></html>", { status: 200 })
    ) as unknown as typeof fetch;

    // limit 3 = exactly the number of undecidable rows. Without the filter they
    // fill the batch and NOTHING resolves; with it, both decidable rows fit.
    const resolved = await reverifyOpenIssues(asDb(db), new Date(), emptyResult(), {
      fetchImpl,
      limit: 3,
    });

    expect(resolved).toBe(2);
    const stillOpen = await db
      .select({ id: healthIssues.id })
      .from(healthIssues)
      .where(isNull(healthIssues.resolvedAt));
    expect(stillOpen.map((r) => r.id).sort()).toEqual(["crawled", "discovered", "unknown"]);
  });
});

describe("OPE-382 — starvation: the tail gets serviced", () => {
  it("reaches rows beyond the batch limit on the next run, even when the head stays open", async () => {
    const db = makeDb();
    // 6 decidable rows. The first 3 are genuinely still broken (they keep
    // returning 500), so they never resolve and, pre-fix, would occupy the
    // batch forever.
    seed(db, [
      { id: "stuck-a", message: "Server error (5xx)", detectedAt: 100 },
      { id: "stuck-b", message: "Server error (5xx)", detectedAt: 101 },
      { id: "stuck-c", message: "Server error (5xx)", detectedAt: 102 },
      { id: "tail-a", message: "Server error (5xx)", detectedAt: 200 },
      { id: "tail-b", message: "Server error (5xx)", detectedAt: 201 },
      { id: "tail-c", message: "Server error (5xx)", detectedAt: 202 },
    ]);

    const seen: string[][] = [];
    let wave: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url);
      wave.push(u);
      // The three "stuck" pages really are still 500ing; the tail serves 200.
      return new Response("", { status: u.includes("/blog/stuck-") ? 500 : 200 });
    }) as unknown as typeof fetch;

    // Run 1 — limit 3, so only the head is attempted.
    await reverifyOpenIssues(asDb(db), new Date(1_000_000), emptyResult(), { fetchImpl, limit: 3 });
    seen.push(wave);
    wave = [];

    // Run 2 — the head is still open (still 500ing) but its cursor advanced, so
    // this run MUST see the tail. Pre-fix it saw the identical three rows.
    await reverifyOpenIssues(asDb(db), new Date(2_000_000), emptyResult(), { fetchImpl, limit: 3 });
    seen.push(wave);

    expect(seen[0].every((u) => u.includes("/blog/stuck-"))).toBe(true);
    expect(seen[1].every((u) => u.includes("/blog/tail-"))).toBe(true);
    // The regression this test exists for: the two runs must not overlap.
    expect(seen[0].filter((u) => seen[1].includes(u))).toHaveLength(0);

    // And the tail actually closed, as verified_fixed.
    const stillOpen = await db
      .select({ id: healthIssues.id })
      .from(healthIssues)
      .where(isNull(healthIssues.resolvedAt));
    expect(stillOpen.map((r) => r.id).sort()).toEqual(["stuck-a", "stuck-b", "stuck-c"]);
  });

  it("stamps the cursor on every attempt, including rows it could not close", async () => {
    const db = makeDb();
    seed(db, [{ id: "broken", message: "Server error (5xx)", detectedAt: 100 }]);

    const fetchImpl = vi.fn(
      async () => new Response("", { status: 503 })
    ) as unknown as typeof fetch;
    await reverifyOpenIssues(asDb(db), new Date(5_000_000), emptyResult(), { fetchImpl });

    const [row] = await db
      .select({
        resolvedAt: healthIssues.resolvedAt,
        lastReverifiedAt: healthIssues.lastReverifiedAt,
      })
      .from(healthIssues)
      .where(eq(healthIssues.id, "broken"));

    // Still open — a 503 is not a recovery...
    expect(row.resolvedAt).toBeNull();
    // ...but the attempt is recorded, which is what stops it blocking the queue.
    expect(row.lastReverifiedAt).not.toBeNull();
  });
});

describe("OPE-382 — the SQL probes and the classifier cannot drift apart", () => {
  it("every locally-decidable message is matched by exactly one SQL probe", () => {
    for (const message of Object.values(LOCALLY_DECIDABLE_MESSAGES)) {
      const matching = LOCALLY_DECIDABLE_SQL_PROBES.filter((p) => message.includes(p));
      expect(matching, `no SQL probe matches "${message}"`).toHaveLength(1);
    }
  });

  it("every SQL probe corresponds to a class the classifier recognises", () => {
    // Guards the silent-narrowing mutation: adding a probe without teaching
    // `classifyMessage` would pull rows the pass then declares undecidable,
    // burning fetches on rows it cannot close — the exact waste this fixed.
    for (const probe of LOCALLY_DECIDABLE_SQL_PROBES) {
      const message = Object.values(LOCALLY_DECIDABLE_MESSAGES).find((m) => m.includes(probe));
      expect(message, `probe "${probe}" matches no known message`).toBeDefined();
      expect(classifyMessage(message!)).not.toBeNull();
    }
  });
});
