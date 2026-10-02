/**
 * OPE-1280 — `url_health_checks` verdicts reach the site-health queue, keyed on
 * `source_field`, and LEAVE it when a re-check disproves them.
 *
 * Real in-memory better-sqlite3 (as OPE-382's suite): the open / refresh /
 * resolve decisions live in the SQL, so a mocked builder would assert nothing.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import { healthIssues } from "../db/schema";
import {
  projectUrlHealthVerdict,
  urlHealthMessage,
  urlHealthFingerprint,
  URL_HEALTH_SOURCE,
} from "../url-health-issues";
import { refreshOpenSeverities } from "../gsc-sweep";

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
    last_reverified_at INTEGER
  );
`;

function makeDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(SCHEMA_SQL);
  return drizzle(sqlite, { schema });
}
const asDb = (db: ReturnType<typeof makeDb>) =>
  db as unknown as Parameters<typeof projectUrlHealthVerdict>[0];

const P = "promoters.website";
const URL_A = "https://ledyardfair.org/";
const DAY1 = new Date("2026-10-01T06:00:00Z");
const DAY2 = new Date("2026-10-02T06:00:00Z");
const DAY3 = new Date("2026-10-03T06:00:00Z");

const check = (
  verdict: string,
  checkedAt: Date,
  over: Partial<{ sourceField: string; url: string; httpStatus: number | null }> = {}
) => ({
  sourceField: over.sourceField ?? P,
  url: over.url ?? URL_A,
  verdict,
  httpStatus: over.httpStatus === undefined ? 404 : over.httpStatus,
  checkedAt,
});

const all = (db: ReturnType<typeof makeDb>) => db.select().from(healthIssues).all();

describe("a non-green verdict becomes a row an operator sees", () => {
  it("ACCEPTANCE: http_error opens a URL_HEALTH row with the URL, the verdict and when it was last checked", async () => {
    const db = makeDb();
    const r = await projectUrlHealthVerdict(asDb(db), check("http_error", DAY1));
    expect(r).toEqual({ opened: 1, reopened: 0, refreshed: 0, resolved: 0 });

    const [row] = all(db);
    expect(row.source).toBe(URL_HEALTH_SOURCE);
    expect(row.issueType).toBe("URL_HEALTH_HTTP_ERROR");
    expect(row.severity).toBe("WARNING");
    expect(row.url).toBe(URL_A);
    expect(row.message).toBe(
      "promoters.website returns an HTTP error · HTTP 404 · last checked 2026-10-01"
    );
    expect(row.lastDetectedAt.getTime()).toBe(DAY1.getTime());
    expect(row.resolvedAt).toBeNull();
  });

  it("the two 'visitor lands somewhere wrong' verdicts are ERROR; broken links are WARNING", async () => {
    const db = makeDb();
    for (const [v, u] of [
      ["domain_takeover", "https://a.example/"],
      ["closure_notice", "https://b.example/"],
      ["http_error", "https://c.example/"],
      ["unreachable", "https://d.example/"],
    ]) {
      await projectUrlHealthVerdict(asDb(db), check(v, DAY1, { url: u }));
    }
    const sev = Object.fromEntries(all(db).map((r) => [r.issueType, r.severity]));
    expect(sev).toEqual({
      URL_HEALTH_DOMAIN_TAKEOVER: "ERROR",
      URL_HEALTH_CLOSURE_NOTICE: "ERROR",
      URL_HEALTH_HTTP_ERROR: "WARNING",
      URL_HEALTH_UNREACHABLE: "WARNING",
    });
  });

  it("no_event_signal is NOT projected (sized out) and ok opens nothing", async () => {
    const db = makeDb();
    await projectUrlHealthVerdict(asDb(db), check("no_event_signal", DAY1, { httpStatus: 200 }));
    await projectUrlHealthVerdict(asDb(db), check("ok", DAY1, { url: "https://x.example/" }));
    expect(all(db)).toHaveLength(0);
  });
});

describe("ONE code path for every source_field — OPE-1270 inherits it", () => {
  it("ACCEPTANCE: vendors.website produces its own row through the same function, no branch", async () => {
    const db = makeDb();
    await projectUrlHealthVerdict(asDb(db), check("unreachable", DAY1, { httpStatus: null }));
    await projectUrlHealthVerdict(
      asDb(db),
      check("unreachable", DAY1, { sourceField: "vendors.website", httpStatus: null })
    );
    const rows = all(db);
    // Same URL on two records is two facts, not one row.
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.message).sort()).toEqual([
      "promoters.website did not respond · no response · last checked 2026-10-01",
      "vendors.website did not respond · no response · last checked 2026-10-01",
    ]);
  });

  it("clearing the promoter row leaves the vendor row open", async () => {
    const db = makeDb();
    await projectUrlHealthVerdict(asDb(db), check("http_error", DAY1));
    await projectUrlHealthVerdict(
      asDb(db),
      check("http_error", DAY1, { sourceField: "vendors.website" })
    );
    await projectUrlHealthVerdict(asDb(db), check("ok", DAY2, { httpStatus: 200 }));
    const open = all(db).filter((r) => r.resolvedAt === null);
    expect(open).toHaveLength(1);
    expect(open[0].message).toMatch(/^vendors\.website /);
  });
});

describe("it resolves (OPE-373) — a source that only accumulates is the defect", () => {
  it("ACCEPTANCE: a URL that returns to ok clears its open row as verified_fixed, end to end", async () => {
    const db = makeDb();
    await projectUrlHealthVerdict(asDb(db), check("http_error", DAY1));
    const r = await projectUrlHealthVerdict(asDb(db), check("ok", DAY2, { httpStatus: 200 }));
    expect(r.resolved).toBe(1);

    const [row] = all(db);
    expect(row.resolvedAt?.getTime()).toBe(DAY2.getTime());
    expect(row.resolutionReason).toBe("verified_fixed");
    expect(row.message).toContain("resolved: now reads ok (2026-10-02)");
  });

  it("a different bad verdict supersedes the old row and opens its own", async () => {
    const db = makeDb();
    await projectUrlHealthVerdict(asDb(db), check("http_error", DAY1));
    const r = await projectUrlHealthVerdict(
      asDb(db),
      check("unreachable", DAY2, { httpStatus: null })
    );
    expect(r).toEqual({ opened: 1, reopened: 0, refreshed: 0, resolved: 1 });
    const byType = Object.fromEntries(all(db).map((x) => [x.issueType, x]));
    expect(byType.URL_HEALTH_HTTP_ERROR.resolutionReason).toBe("superseded");
    expect(byType.URL_HEALTH_UNREACHABLE.resolvedAt).toBeNull();
  });

  it("an unprojected verdict (no_event_signal) still closes the old row — it is a fresh check", async () => {
    const db = makeDb();
    await projectUrlHealthVerdict(asDb(db), check("http_error", DAY1));
    await projectUrlHealthVerdict(asDb(db), check("no_event_signal", DAY2, { httpStatus: 200 }));
    const [row] = all(db);
    expect(row.resolutionReason).toBe("superseded");
  });

  it("a recurrence re-opens the same row rather than minting a duplicate", async () => {
    const db = makeDb();
    await projectUrlHealthVerdict(asDb(db), check("http_error", DAY1));
    await projectUrlHealthVerdict(asDb(db), check("ok", DAY2, { httpStatus: 200 }));
    const r = await projectUrlHealthVerdict(
      asDb(db),
      check("http_error", DAY3, { httpStatus: 500 })
    );
    expect(r.reopened).toBe(1);
    const rows = all(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].resolvedAt).toBeNull();
    expect(rows[0].resolutionReason).toBeNull();
    expect(rows[0].message).toContain("HTTP 500 · last checked 2026-10-03");
  });

  it("a repeat of the same verdict refreshes last_detected_at (OPE-567 freshness), no duplicate", async () => {
    const db = makeDb();
    await projectUrlHealthVerdict(asDb(db), check("http_error", DAY1));
    const r = await projectUrlHealthVerdict(asDb(db), check("http_error", DAY2));
    expect(r.refreshed).toBe(1);
    const rows = all(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].lastDetectedAt.getTime()).toBe(DAY2.getTime());
    expect(rows[0].firstDetectedAt.getTime()).toBe(DAY1.getTime());
    expect(rows[0].message).toContain("last checked 2026-10-02");
  });
});

describe("the nightly severity pass leaves non-GSC rows alone", () => {
  it("a URL_HEALTH ERROR survives refreshOpenSeverities — while a GSC row is still re-graded", async () => {
    const db = makeDb();
    await projectUrlHealthVerdict(asDb(db), check("domain_takeover", DAY1, { httpStatus: 200 }));
    // Positive landmark: a GSC row whose message maps to ERROR, stored as WARNING.
    db.insert(healthIssues)
      .values({
        fingerprint: "gsc-1",
        source: "GSC_URL_INSPECTION",
        issueType: "GSC_INSPECTION_NON_OK",
        severity: "WARNING",
        url: "https://meetmeatthefair.com/x",
        message: "Server error (5xx)",
        firstDetectedAt: DAY1,
        lastDetectedAt: DAY1,
      })
      .run();

    const changed = await refreshOpenSeverities(
      db as unknown as Parameters<typeof refreshOpenSeverities>[0]
    );
    expect(changed).toBe(1); // the GSC row, proving the pass ran
    const sev = Object.fromEntries(all(db).map((r) => [r.source, r.severity]));
    expect(sev).toEqual({ URL_HEALTH: "ERROR", GSC_URL_INSPECTION: "ERROR" });
  });
});

describe("one Site Health group per (source_field, verdict)", () => {
  // The tab groups on source|issue_type|message with digit runs folded to '#'
  // (normalizeHealthMessageKey in admin/analytics/page.tsx).
  const fold = (m: string) => m.toLowerCase().replace(/\d+/g, "#");

  it("different statuses and dates fold to one key; different fields do not", () => {
    const a = urlHealthMessage(P, "http_error", 404, DAY1);
    const b = urlHealthMessage(P, "http_error", 503, DAY3);
    const v = urlHealthMessage("vendors.website", "http_error", 404, DAY1);
    expect(fold(a)).toBe(fold(b));
    expect(fold(a)).not.toBe(fold(v));
  });

  it("the fingerprint separates source_field and verdict, and is stable", async () => {
    const f1 = await urlHealthFingerprint(P, URL_A, "http_error");
    expect(await urlHealthFingerprint(P, URL_A, "http_error")).toBe(f1);
    expect(await urlHealthFingerprint("vendors.website", URL_A, "http_error")).not.toBe(f1);
    expect(await urlHealthFingerprint(P, URL_A, "unreachable")).not.toBe(f1);
  });
});

describe("the promoter sweep calls it (source-level)", () => {
  const SRC = readFileSync(
    join(process.cwd(), "src/app/api/admin/url-health/promoters/sweep/route.ts"),
    "utf8"
  );

  it("projects every check, after the check row is written", () => {
    const insert = SRC.indexOf("await db.insert(urlHealthChecks).values(");
    const call = SRC.indexOf("await projectUrlHealthVerdict(db, {");
    expect(insert).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(insert);
    expect(SRC.slice(call, call + 200)).toContain("sourceField: SOURCE_FIELD");
  });
});
