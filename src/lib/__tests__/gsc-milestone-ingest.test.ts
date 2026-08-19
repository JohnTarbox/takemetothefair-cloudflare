import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import type { Database as AppDb } from "../db";
import { ingestGscMilestone } from "../gsc-milestone-ingest";
import { parseGscMilestoneEmail } from "../gsc-milestone-email";

const SCHEMA_SQL = `
  CREATE TABLE gsc_milestone_emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    metric TEXT NOT NULL DEFAULT 'clicks',
    window_days INTEGER NOT NULL DEFAULT 28,
    threshold INTEGER NOT NULL,
    reached_date TEXT,
    -- OPE-456 (drizzle/0210) — how reached_date was obtained.
    reached_date_source TEXT,
    email_date TEXT NOT NULL,
    site_url TEXT NOT NULL DEFAULT 'https://meetmeatthefair.com/',
    source TEXT NOT NULL DEFAULT 'google_search_console_email',
    note TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
`;

let raw: InstanceType<typeof Database>;
let db: AppDb;

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema }) as unknown as AppDb;
});

describe("ingestGscMilestone (OPE-108)", () => {
  it("inserts a new milestone with defaults filled in", async () => {
    const m = parseGscMilestoneEmail({
      subject: "Congrats on reaching 3K clicks in 28 days!",
      body: "reached 3K ... Jul 4, 2026",
      emailDate: "2026-07-06",
    })!;
    const res = await ingestGscMilestone(db, m);
    expect(res.inserted).toBe(true);
    expect(res.row).toMatchObject({
      metric: "clicks",
      windowDays: 28,
      threshold: 3000,
      reachedDate: "2026-07-04",
      emailDate: "2026-07-06",
      siteUrl: "https://meetmeatthefair.com/",
      source: "google_search_console_email",
    });
  });

  it("is idempotent on (metric, window, threshold) — a re-send keeps the earliest row", async () => {
    const first = parseGscMilestoneEmail({
      subject: "Congrats on reaching 3K clicks in 28 days!",
      emailDate: "2026-07-06",
    })!;
    await ingestGscMilestone(db, first);

    // Google re-sends the same 3K threshold a week later.
    const resend = parseGscMilestoneEmail({
      subject: "Congrats on reaching 3K clicks in 28 days!",
      emailDate: "2026-07-13",
    })!;
    const res2 = await ingestGscMilestone(db, resend);

    expect(res2.inserted).toBe(false);
    // Kept the earliest email_date, no duplicate row.
    expect(res2.row.emailDate).toBe("2026-07-06");
    expect(raw.prepare("SELECT COUNT(*) c FROM gsc_milestone_emails").get()).toEqual({ c: 1 });
  });

  it("distinct thresholds each insert (the backfill would produce 1200/1500/3000)", async () => {
    for (const [n, email] of [
      ["1.2K", "2026-06-20"],
      ["1.5K", "2026-06-26"],
      ["3K", "2026-07-06"],
    ] as const) {
      const m = parseGscMilestoneEmail({
        subject: `Congrats on reaching ${n} clicks in 28 days!`,
        emailDate: email,
      })!;
      const res = await ingestGscMilestone(db, m);
      expect(res.inserted).toBe(true);
    }
    const rows = raw
      .prepare("SELECT threshold FROM gsc_milestone_emails ORDER BY threshold")
      .all() as Array<{ threshold: number }>;
    expect(rows.map((r) => r.threshold)).toEqual([1200, 1500, 3000]);
  });
});

/**
 * OPE-456 — a later, better-sourced call must be able to correct a row.
 *
 * The old contract was "first write wins, forever": correct information supplied
 * afterwards came back as `inserted: false` and was discarded, which made every
 * ingest bug unfixable through the tool that caused it. The repair path was
 * direct DB access — which is how row 18 actually got corrected.
 */
describe("OPE-456 — correction, in one direction only", () => {
  const base = (over: Record<string, unknown> = {}) => ({
    metric: "clicks",
    windowDays: 28,
    threshold: 12000,
    reachedDate: "2026-08-17",
    reachedDateSource: "unanchored" as const,
    emailDate: "2026-08-17",
    ...over,
  });

  it("an anchored parse supersedes an unanchored one, and says so", async () => {
    const first = await ingestGscMilestone(db, base() as never);
    expect(first.inserted).toBe(true);

    const second = await ingestGscMilestone(
      db,
      base({ reachedDate: "2026-08-15", reachedDateSource: "anchored" }) as never
    );
    expect(second.inserted).toBe(false);
    expect(second.corrected).toBe(true);
    expect(second.row.reachedDate).toBe("2026-08-15");
    expect(second.row.reachedDateSource).toBe("anchored");
    expect(second.outcome).toMatch(/corrected/i);
  });

  it("an unanchored parse NEVER supersedes an anchored one", async () => {
    // The reverse direction is what makes this safe. Without it, a re-forward
    // would overwrite Google's date with the date of the re-forward — the same
    // defect, arriving later.
    await ingestGscMilestone(
      db,
      base({ reachedDate: "2026-08-15", reachedDateSource: "anchored" }) as never
    );
    const again = await ingestGscMilestone(db, base() as never);

    expect(again.corrected).toBe(false);
    expect(again.row.reachedDate).toBe("2026-08-15");
    expect(again.outcome).toMatch(/anchored/i);
  });

  it("an anchored parse fills a row whose provenance is unknown (pre-column rows)", async () => {
    await ingestGscMilestone(db, base({ reachedDateSource: null }) as never);
    const fixed = await ingestGscMilestone(
      db,
      base({ reachedDate: "2026-08-15", reachedDateSource: "anchored" }) as never
    );
    expect(fixed.corrected).toBe(true);
    expect(fixed.row.reachedDate).toBe("2026-08-15");
  });
});
