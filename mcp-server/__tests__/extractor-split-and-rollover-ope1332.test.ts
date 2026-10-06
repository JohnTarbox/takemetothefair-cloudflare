/**
 * OPE-1332 — two guards, MCP side.
 *
 * 1. The inbound fan-out refuses the year-borrowed twin of a year-less day
 *    ("our 2027 Lilac Festival … planning meeting on October 15th" → 2026-10-15
 *    and an invented 2027-10-15) through the OPE-1253 refusal channel. The
 *    decision itself is `yearlessDaySplitLosers` (utils, tested there on the
 *    real email text); the Workflow method is private, so the wiring is pinned
 *    on its CALL syntax — an import line cannot satisfy these assertions.
 *
 * 2. K27 rollover rolls only an APPROVED (adjudicated) source. Pass 2 of the
 *    occurred-sweep and the manual lifecycle path filter on lifecycle alone,
 *    so the core is the one gate every caller passes through.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { rolloverEventIfRecurring } from "../src/event-rollover.js";

describe("fan-out wiring (inbound-email.ts runMultiEventFanOut)", () => {
  const src = readFileSync(join(__dirname, "..", "src", "workflows", "inbound-email.ts"), "utf8");
  const fanOut = src.slice(src.indexOf("private async runMultiEventFanOut("));

  it("computes the split losers from the extracted events and the source texts", () => {
    expect(fanOut).toContain("yearlessDaySplitLosers(extracted.events, sourceTexts, new Date())");
  });
  it("refuses a loser as over-split-year, BEFORE the normal refusal and before any write", () => {
    const refusalAt = fanOut.indexOf('? "over-split-year"');
    const submitAt = fanOut.indexOf("submitCheckDuplicate(");
    expect(refusalAt).toBeGreaterThan(0);
    expect(submitAt).toBeGreaterThan(refusalAt);
  });
  it("records the refusal through the existing channel (fault + admin_actions + flag), never silently", () => {
    const block = fanOut.slice(
      fanOut.indexOf('? "over-split-year"'),
      fanOut.indexOf("submitCheckDuplicate(")
    );
    expect(block).toContain(
      "recordCandidateRefusal(this.env, perEvent, sourceTexts, messageRowId, childRefusal)"
    );
  });
});

describe("rollover eligibility — only an APPROVED source rolls forward", () => {
  let db: TestDb;
  let raw: Database.Database;
  let mock: ReturnType<typeof mockIndexNowFetch>;

  beforeEach(() => {
    ({ db, raw } = createTestDb());
    mock = mockIndexNowFetch();
    raw.prepare(`INSERT INTO promoters (id, company_name, slug) VALUES ('p1', 'P', 'p')`).run();
  });
  afterEach(() => {
    mock.restore();
    raw.close();
  });

  function seed(id: string, status: string) {
    const s = Math.floor(Date.UTC(2026, 9, 4, 12) / 1000);
    raw
      .prepare(
        `INSERT INTO events (id, name, slug, promoter_id, start_date, end_date, status, lifecycle_status, recurrence_rule)
         VALUES (?, 'Fair 2026', ?, 'p1', ?, ?, ?, 'OCCURRED', 'FREQ=YEARLY;INTERVAL=1')`
      )
      .run(id, `fair-${id}`, s, s + 86400, status);
  }
  const now = { now: new Date("2026-10-10T00:00:00Z") };

  it.each(["PENDING", "DRAFT", "REJECTED", "CANCELLED", "TENTATIVE"])(
    "a %s source does not roll (source-not-approved) and writes nothing",
    async (status) => {
      seed("src", status);
      const before = (raw.prepare("SELECT count(*) n FROM events").get() as { n: number }).n;
      expect(await rolloverEventIfRecurring(db, "src", now)).toEqual({
        created: false,
        skipReason: "source-not-approved",
      });
      expect((raw.prepare("SELECT count(*) n FROM events").get() as { n: number }).n).toBe(before);
    }
  );

  it("an APPROVED source still rolls (positive landmark: the gate is not a blanket refusal)", async () => {
    seed("src", "APPROVED");
    const r = await rolloverEventIfRecurring(db, "src", now);
    expect(r.created).toBe(true);
  });
});
