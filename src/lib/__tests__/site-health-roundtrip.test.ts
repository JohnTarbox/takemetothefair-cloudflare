/**
 * OPE-373 — the round trip, which the ticket names as the actual deliverable:
 *
 *   "Induce a fixable condition, confirm it opens a row, fix it, confirm the
 *    row auto-resolves on the next cycle."
 *
 * Everything else in this change is machinery. This is the property that says
 * the machinery works end to end, and it is deliberately written as one
 * continuous narrative rather than four isolated unit tests — the defect being
 * fixed was precisely that each step worked while the *cycle* did not close.
 *
 * Also pins the two failure modes that would make the fix worthless in
 * production even with every unit test green:
 *   - a resolved row must not be re-opened by the next sweep (resolve without
 *     suppress = the queue refills by morning);
 *   - "we stopped seeing it" must never be recorded as "we proved it fixed".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import { healthIssues } from "../db/schema";
import { HEALTH_RESOLUTION_REASON } from "@takemetothefair/db-schema";

vi.mock("@/lib/sitemap/indexable-vendors", () => ({ getIndexableVendorRows: async () => [] }));

const { reverifyOpenIssues, expireUndetectedIssues, severityForCoverage } =
  await import("../gsc-sweep");

const HOST = "https://meetmeatthefair.com";
const URL_UNDER_TEST = `${HOST}/vendors/garmin-international`;

const SCHEMA_SQL = `
  CREATE TABLE health_issues (
    id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE, source TEXT, issue_type TEXT,
    severity TEXT, url TEXT, message TEXT, first_detected_at INTEGER,
    last_detected_at INTEGER, resolved_at INTEGER, resolution_reason TEXT
  );
`;

let raw: Database.Database;
let db: any;

const newResult = () => ({
  inspected: 0,
  newIssues: 0,
  resolvedIssues: 0,
  skipped: 0,
  errors: [] as string[],
  resolvedByReason: {} as Record<string, number>,
});

/** Stand-in for the sweep's detect step: GSC reports the page as noindex. */
function openIssue(url: string, message: string, detectedAt: Date, id = "i1") {
  raw
    .prepare(
      `INSERT INTO health_issues (id, fingerprint, source, issue_type, severity, url, message,
       first_detected_at, last_detected_at, resolved_at) VALUES (?,?,?,?,?,?,?,?,?,NULL)`
    )
    .run(
      id,
      `fp-${id}`,
      "GSC_URL_INSPECTION",
      "GSC_INSPECTION_NON_OK",
      severityForCoverage(message, "NEUTRAL"),
      url,
      message,
      Math.floor(detectedAt.getTime() / 1000),
      Math.floor(detectedAt.getTime() / 1000)
    );
}

const pageWith = (body: string, status = 200) =>
  (async () => new Response(body, { status })) as unknown as typeof fetch;

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

describe("OPE-373 round trip: broken → detected → fixed → auto-resolved", () => {
  it("closes the row on the next cycle once the page is genuinely fixed", async () => {
    const day1 = new Date("2026-08-01T06:00:00Z");

    // 1. INDUCE — the vendor is at MENTION tier and correctly emits noindex.
    //    GSC sees it and the sweep opens a row.
    openIssue(URL_UNDER_TEST, "Excluded by ‘noindex’ tag", day1);

    let [row]: any[] = await db.select().from(healthIssues);
    expect(row.resolvedAt).toBeNull();
    expect(row.severity).toBe("WARNING"); // actionable: a page WE publish is noindex'd

    // 2. CONFIRM IT STAYS OPEN while the condition genuinely holds. A pass that
    //    closes rows regardless would look identical at step 4.
    const stillBroken = newResult();
    await reverifyOpenIssues(db, new Date("2026-08-02T06:00:00Z"), stillBroken, {
      fetchImpl: pageWith(`<meta name="robots" content="noindex">`),
    });
    [row] = await db.select().from(healthIssues);
    expect(row.resolvedAt).toBeNull();
    expect(stillBroken.resolvedIssues).toBe(0);

    // 3. FIX — the vendor is enriched into STANDARD tier; the page now serves
    //    200 with no robots directive. Google has NOT re-crawled, so GSC would
    //    still answer "Excluded by 'noindex'". That is the whole point: the old
    //    path could never get past this step.
    const cycle = newResult();
    await reverifyOpenIssues(db, new Date("2026-08-03T06:00:00Z"), cycle, {
      fetchImpl: pageWith("<html><body>Garmin International</body></html>"),
    });

    // 4. AUTO-RESOLVED, with the strong reason — we proved it, we did not
    //    merely stop seeing it.
    [row] = await db.select().from(healthIssues);
    expect(row.resolvedAt).not.toBeNull();
    expect(row.resolutionReason).toBe(HEALTH_RESOLUTION_REASON.VERIFIED_FIXED);
    expect(cycle.resolvedIssues).toBe(1);
    expect(cycle.resolvedByReason[HEALTH_RESOLUTION_REASON.VERIFIED_FIXED]).toBe(1);
  });

  it("does not re-resolve or double-count a row already closed", async () => {
    const day1 = new Date("2026-08-01T06:00:00Z");
    openIssue(URL_UNDER_TEST, "Excluded by ‘noindex’ tag", day1);

    const first = newResult();
    await reverifyOpenIssues(db, new Date("2026-08-03T06:00:00Z"), first, {
      fetchImpl: pageWith("<html>fixed</html>"),
    });
    const second = newResult();
    await reverifyOpenIssues(db, new Date("2026-08-04T06:00:00Z"), second, {
      fetchImpl: pageWith("<html>fixed</html>"),
    });

    expect(first.resolvedIssues).toBe(1);
    // The pass selects only rows with resolved_at IS NULL, so a closed row is
    // invisible to it. Without that, every daily run would re-count the same
    // closure and the outflow metric would drift upward forever.
    expect(second.resolvedIssues).toBe(0);
  });
});

describe("OPE-373 expiry never masquerades as a fix", () => {
  it("closes an unobserved row as no_longer_detected, not verified_fixed", async () => {
    const now = new Date("2026-08-11T06:00:00Z");
    // Last seen 40 days ago — well past the 21-day window.
    openIssue(URL_UNDER_TEST, "URL is unknown to Google", new Date("2026-07-02T06:00:00Z"));

    const result = newResult();
    const n = await expireUndetectedIssues(db, now, 21, result);

    expect(n).toBe(1);
    const [row]: any[] = await db.select().from(healthIssues);
    expect(row.resolutionReason).toBe(HEALTH_RESOLUTION_REASON.NO_LONGER_DETECTED);
    // The distinction that matters: this closure is equally consistent with the
    // problem going away and with us going blind to it. Recording it as
    // verified_fixed would erase that, and blindness is what this queue exists
    // to catch.
    expect(row.resolutionReason).not.toBe(HEALTH_RESOLUTION_REASON.VERIFIED_FIXED);
  });

  it("leaves a recently-seen row alone", async () => {
    const now = new Date("2026-08-11T06:00:00Z");
    openIssue(URL_UNDER_TEST, "URL is unknown to Google", new Date("2026-08-09T06:00:00Z"));

    const result = newResult();
    expect(await expireUndetectedIssues(db, now, 21, result)).toBe(0);
    const [row]: any[] = await db.select().from(healthIssues);
    expect(row.resolvedAt).toBeNull();
  });

  it("does not expire a row merely waiting its turn in a slow rotation", async () => {
    // ~2,200 sitemap URLs at ~50-60 inspected/day means a URL comes round about
    // monthly. A 7-day window would close rows that are simply un-rechecked —
    // manufacturing a false recovery, which is worse than a stale row. This
    // pins why the default is 21 and not something tighter.
    const now = new Date("2026-08-11T06:00:00Z");
    openIssue(URL_UNDER_TEST, "Crawled - currently not indexed", new Date("2026-07-29T06:00:00Z"));

    const result = newResult();
    expect(await expireUndetectedIssues(db, now, 21, result)).toBe(0);
  });
});

describe("OPE-373 severity reflects actionability", () => {
  it("rates a live 5xx as ERROR — someone must act today", () => {
    expect(severityForCoverage("Server error (5xx)", "FAIL")).toBe("ERROR");
  });

  it("rates a noindex page we publish as WARNING — our mistake, fixable", () => {
    expect(severityForCoverage("Excluded by ‘noindex’ tag", "NEUTRAL")).toBe("WARNING");
  });

  it("demotes Google's own indexing choices to INFO", () => {
    // Real signal in aggregate, no per-URL action. Previously these were
    // WARNING and made up 214 of 326 open rows, drowning the handful that a
    // human could actually do something about.
    for (const c of [
      "Crawled - currently not indexed",
      "Discovered - currently not indexed",
      "URL is unknown to Google",
      "Page with redirect",
    ]) {
      expect(severityForCoverage(c, "NEUTRAL")).toBe("INFO");
    }
  });
});
