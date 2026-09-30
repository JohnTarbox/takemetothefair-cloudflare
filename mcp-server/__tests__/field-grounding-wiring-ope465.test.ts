/**
 * OPE-465 — the verifier is wired at the one chokepoint, and cannot be skipped.
 *
 * `packages/utils/src/__tests__/field-grounding.test.ts` proves the verdicts.
 * This file proves the two things that file cannot: that `submitEvent`
 * actually drops what the source does not support before POSTing, and that a
 * future creation path cannot quietly stop passing the source text.
 *
 * The second half is the one that matters in six months. This codebase's
 * most-repeated defect is a fix wired into one of several parallel paths —
 * there are FIVE `submitEvent` call sites across four pipelines — so the guard
 * is keyed on the ACT (calling submitEvent) rather than on the fix.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestDb, type TestDb } from "./setup-db.js";
import type Database from "better-sqlite3";
// `getDb` builds a **D1** drizzle; this harness is better-sqlite3. The two
// overlap enough that INSERTs work and SELECTs silently do not (D1 returns
// `{results}`, better-sqlite3 returns an array), which made the fault emitter
// swallow its own error and look like a no-op. Mocked exactly as
// `extraction-faults-ope463.test.ts` does, so the emitter is really exercised.
vi.mock("../src/db.js", () => ({ getDb: () => db }));

import { submitEvent, type SubmitExtractResult } from "../src/email-handlers/submit.js";

const NOV_7_FLYER =
  "Holiday Craft Fair — Saturday, November 7, 2026, 9am to 2pm. Free admission at the community center.";

let db: TestDb;
let raw: Database.Database;
let posted: Record<string, unknown> | null = null;

function extracted(overrides: Partial<SubmitExtractResult["event"]> = {}): SubmitExtractResult {
  const event = {
    name: "Holiday Craft Fair",
    startDate: "2026-11-01",
    endDate: "2026-11-30",
    venueName: "Community Center",
    ...overrides,
  } as SubmitExtractResult["event"];
  return {
    url: "https://example.org/fair",
    event,
    fieldConfidence: {},
    extractionMethod: "ai",
    totalEventsDetected: 1,
    additionalEventNames: [],
    events: [event],
  };
}

function envFor(): Parameters<typeof submitEvent>[0] {
  return {
    MAIN_APP_URL: "https://meetmeatthefair.com",
    INTERNAL_API_KEY: "k",
    DB: raw as unknown as D1Database,
  } as unknown as Parameters<typeof submitEvent>[0];
}

/** The OPE-463 table, as `extraction-faults-ope463.test.ts` declares it — the
 *  shared harness does not carry it. */
const EXTRACTION_FAULTS_SQL = `
  CREATE TABLE IF NOT EXISTS extraction_faults (
    signature TEXT PRIMARY KEY, source TEXT NOT NULL, family_id TEXT NOT NULL,
    detail TEXT, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
    count INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'proposed',
    ope_id TEXT, filed_at INTEGER, resolved_at INTEGER, created_at INTEGER NOT NULL
  );
`;

beforeEach(() => {
  ({ db, raw } = createTestDb());
  raw.exec(EXTRACTION_FAULTS_SQL);
  posted = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      posted = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ success: true, event: { id: "evt-1", slug: "holiday-craft-fair" } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    })
  );
  raw
    .prepare(
      `INSERT INTO inbound_emails (id, received_at, created_at, from_address, to_address, intent, subject)
       VALUES ('in-1', 0, 0, 'organizer@example.org', 'submit@meetmeatthefair.com', 'new_event', 'fair')`
    )
    .run();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("submitEvent applies the verdict before the POST", () => {
  it("does NOT send a whole-month span the source never stated", async () => {
    await submitEvent(envFor(), extracted(), "organizer@example.org", {
      inboundEmailId: "in-1",
      dedupWasBlind: false,
      sourceTexts: [NOV_7_FLYER],
    });
    expect(posted).not.toBeNull();
    // The abstention: the fields are absent from the write, not "corrected"
    // to a guess. The event itself is still created — it is real.
    expect(posted!.startDate).toBeNull();
    expect(posted!.endDate).toBeNull();
    expect(posted!.name).toBe("Holiday Craft Fair");
  });

  it("sends a date the source states, unchanged", async () => {
    await submitEvent(
      envFor(),
      extracted({ startDate: "2026-11-07", endDate: "2026-11-07" }),
      "organizer@example.org",
      { inboundEmailId: "in-1", dedupWasBlind: false, sourceTexts: [NOV_7_FLYER] }
    );
    expect(posted!.startDate).toBe("2026-11-07");
    expect(posted!.endDate).toBe("2026-11-07");
  });

  it("with no sourceTexts, behaves exactly as before — an unwired caller is unchanged", async () => {
    await submitEvent(envFor(), extracted(), "organizer@example.org", {
      inboundEmailId: "in-1",
      dedupWasBlind: false,
    });
    expect(posted!.startDate).toBe("2026-11-01");
    expect(posted!.endDate).toBe("2026-11-30");
  });
});

describe("it emits rather than silently suppressing (scope 4)", () => {
  it("writes one extraction fault per dropped field, and re-running bumps rather than duplicates", async () => {
    const call = () =>
      submitEvent(envFor(), extracted(), "organizer@example.org", {
        inboundEmailId: "in-1",
        dedupWasBlind: false,
        sourceTexts: [NOV_7_FLYER],
      });
    await call();
    const after1 = raw
      .prepare("SELECT signature, count, detail FROM extraction_faults ORDER BY signature")
      .all() as { signature: string; count: number; detail: string }[];
    expect(after1.map((r) => r.signature)).toEqual([
      "extract.unsupported_field:end_date",
      "extract.unsupported_field:start_date",
    ]);
    expect(after1[1].detail).toContain("2026-11-07");

    await call();
    const after2 = raw
      .prepare("SELECT signature, count FROM extraction_faults ORDER BY signature")
      .all() as { signature: string; count: number }[];
    expect(after2).toHaveLength(2);
    expect(after2.every((r) => r.count === 2)).toBe(true);
  });

  it("records the verdicts on admin_actions and flags the inbound row", async () => {
    await submitEvent(envFor(), extracted(), "organizer@example.org", {
      inboundEmailId: "in-1",
      dedupWasBlind: false,
      sourceTexts: [NOV_7_FLYER],
    });
    const action = raw
      .prepare("SELECT action, target_id, payload_json FROM admin_actions WHERE action = ?")
      .get("extract.ungrounded") as { target_id: string; payload_json: string };
    expect(action.target_id).toBe("evt-1");
    const payload = JSON.parse(action.payload_json) as {
      droppedFields: string[];
      verdicts: { field: string; verdict: string; reason: string }[];
    };
    expect(payload.droppedFields).toEqual(["start_date", "end_date"]);
    expect(payload.verdicts.every((v) => v.verdict === "unsupported")).toBe(true);
    const row = raw
      .prepare("SELECT flagged_for_review FROM inbound_emails WHERE id = 'in-1'")
      .get() as { flagged_for_review: number };
    expect(row.flagged_for_review).toBe(1);
  });

  it("writes no fault when nothing was dropped", async () => {
    await submitEvent(
      envFor(),
      extracted({ startDate: "2026-11-07", endDate: "2026-11-07" }),
      "organizer@example.org",
      { inboundEmailId: "in-1", dedupWasBlind: false, sourceTexts: [NOV_7_FLYER] }
    );
    const n = raw.prepare("SELECT COUNT(*) n FROM extraction_faults").get() as { n: number };
    expect(n.n).toBe(0);
  });
});

describe("structural guard — no creation path can skip the source text", () => {
  const SRC = readFileSync(
    fileURLToPath(new URL("../src/workflows/inbound-email.ts", import.meta.url)),
    "utf8"
  );

  it("finds every submitEvent call site (a zero here would make the guard inert)", () => {
    const calls = SRC.match(/submitEvent\(this\.env,/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(5);
  });

  it("every submitEvent call passes sourceTexts", () => {
    const offenders: string[] = [];
    const re = /submitEvent\(this\.env,/g;
    for (let m = re.exec(SRC); m; m = re.exec(SRC)) {
      // The call's own argument object ends at the first `})` after it.
      const tail = SRC.slice(m.index, SRC.indexOf("})", m.index) + 2);
      if (!tail.includes("sourceTexts")) {
        offenders.push(`line ${SRC.slice(0, m.index).split("\n").length}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every submitExtractedEvent call passes a source array too", () => {
    // The four callers thread the text down to submitEvent; one that forgets
    // silently degrades to "no source", which grounds everything and drops
    // nothing — a failure that looks exactly like success.
    const re = /this\.submitExtractedEvent\(/g;
    const offenders: string[] = [];
    for (let m = re.exec(SRC); m; m = re.exec(SRC)) {
      const tail = SRC.slice(m.index, SRC.indexOf(");", m.index) + 2);
      if (!/\[[^\]]*\]/.test(tail)) {
        offenders.push(`line ${SRC.slice(0, m.index).split("\n").length}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
