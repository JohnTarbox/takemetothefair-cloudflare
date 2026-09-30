/**
 * OPE-463 — the human verdict becomes a fault candidate.
 *
 * `cpi.config.yaml` lists `inbound_correspondence` as a fault source whose
 * three read surfaces all detect **non-action**: a handler that acknowledged
 * instead of acting, a crossing with no destination, an unanswered human. The
 * expensive failure in this lane is **wrong action**, and it is invisible.
 *
 * The specimen (2026-08-18): one email created **6 PENDING events for 1 real
 * fair**, two of them invented from a sentence saying the December details
 * would follow later, one with a fabricated `2026-11-01 → 2026-11-30` span. The
 * sender was told "thanks for submitting 8 events". It logged
 * `reply_kind='ok-multi'`, `status='replied'` — a success in every view we had.
 *
 * Re-measured 2026-09-06, and the loss has grown since filing:
 *
 *   REJECTED email-submission events        24 (08-18)  ->  36
 *   ...of those carrying a reason            0          ->   0
 *
 * Thirty-six expert judgements about what the extractor got wrong, discarded.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../src/schema.js";
import {
  EXTRACTION_REJECT_FAMILIES,
  humanRejectSignature,
  rejectReasonRequired,
} from "@takemetothefair/constants";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;

vi.mock("../src/db.js", () => ({ getDb: () => db }));

import { emitExtractionFault } from "../src/faults/extraction-emitter.js";

const SCHEMA_SQL = `
  CREATE TABLE extraction_faults (
    signature TEXT PRIMARY KEY, source TEXT NOT NULL, family_id TEXT NOT NULL,
    detail TEXT, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
    count INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'proposed',
    ope_id TEXT, filed_at INTEGER, resolved_at INTEGER, created_at INTEGER NOT NULL
  );
`;

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

const rows = () =>
  raw.prepare(`SELECT * FROM extraction_faults`).all() as Array<{
    signature: string;
    family_id: string;
    count: number;
    status: string;
    ope_id: string | null;
    resolved_at: number | null;
  }>;

const emit = (family: string, now?: Date) =>
  emitExtractionFault(db, {
    signature: humanRejectSignature(family as never, "email_submission"),
    source: "email_submission",
    familyId: family,
    detail: "some-slug rejected by operator",
    now,
  });

describe("the reason code is required where a machine wrote the row", () => {
  it("email_submission requires one", () => {
    expect(rejectReasonRequired("email_submission")).toBe(true);
  });

  it("a hand-entered admin row does NOT", () => {
    // The positive landmark, and a deliberate scope limit: a human rejecting a
    // row a human typed is not labelling an extractor. Demanding a family there
    // collects noise and trains the requirement into a nuisance.
    expect(rejectReasonRequired("admin_manual")).toBe(false);
    expect(rejectReasonRequired("vendor_submission")).toBe(false);
    expect(rejectReasonRequired(null)).toBe(false);
    expect(rejectReasonRequired(undefined)).toBe(false);
  });

  it("every family has a real logged instance behind it", () => {
    // Positive landmark on the enum itself — a shrunken list would make the
    // it.each coverage below vacuous.
    expect(EXTRACTION_REJECT_FAMILIES).toHaveLength(8);
    expect(EXTRACTION_REJECT_FAMILIES).toContain("phantom-event"); // the 2 December rows
    expect(EXTRACTION_REJECT_FAMILIES).toContain("fabricated-field"); // the Nov 1-30 span
    expect(EXTRACTION_REJECT_FAMILIES).toContain("over-split"); // 6 events, 1 fair
  });
});

describe("idempotency is by ledger columns, with no side watermark", () => {
  it("a first reject creates one row", async () => {
    expect(await emit("over-split")).toBe("created");
    expect(rows()).toHaveLength(1);
    expect(rows()[0].count).toBe(1);
    expect(rows()[0].status).toBe("proposed");
  });

  it("re-running creates NO duplicate row — it bumps count", async () => {
    // The acceptance criterion, stated exactly: "Re-running the emitters files
    // nothing new and creates no duplicate rows."
    await emit("over-split");
    await emit("over-split");
    await emit("over-split");
    expect(rows()).toHaveLength(1);
    expect(rows()[0].count).toBe(3);
  });

  it("the signature is keyed on the FAMILY, not the event", async () => {
    // Keyed per-event, `count` would never exceed 1 and the recurrence
    // threshold the rail files on could never be met — the fault would be
    // recorded and still never actionable.
    const a = humanRejectSignature("over-split", "email_submission");
    const b = humanRejectSignature("over-split", "email_submission");
    expect(a).toBe(b);
    expect(a).not.toBe(humanRejectSignature("phantom-event", "email_submission"));
  });

  it("different families are different faults", async () => {
    await emit("over-split");
    await emit("phantom-event");
    expect(rows()).toHaveLength(2);
  });

  it("a different SOURCE is a different fault even for the same family", async () => {
    await emit("over-split");
    await emitExtractionFault(db, {
      signature: humanRejectSignature("over-split", "url_import"),
      source: "url_import",
      familyId: "over-split",
    });
    expect(rows()).toHaveLength(2);
  });
});

describe("a resolved fault that recurs is a REGRESSION, not a new row", () => {
  it("re-opens the same row and clears the resolution", async () => {
    await emit("over-split");
    const sig = humanRejectSignature("over-split", "email_submission");
    raw
      .prepare(
        `UPDATE extraction_faults SET status='done', resolved_at=?, ope_id='OPE-1' WHERE signature=?`
      )
      .run(1_750_000_000, sig);

    expect(await emit("over-split")).toBe("reopened");
    // One row, not two: splitting a fault's history in half would reset its
    // recurrence count and hide that it came back.
    expect(rows()).toHaveLength(1);
    expect(rows()[0].status).toBe("regressed");
    expect(rows()[0].resolved_at).toBeNull();
    expect(rows()[0].ope_id).toBeNull();
    expect(rows()[0].count).toBe(2);
  });

  it("an UNresolved recurrence is not a regression", async () => {
    await emit("over-split");
    expect(await emit("over-split")).toBe("recurred");
    expect(rows()[0].status).toBe("proposed");
  });
});

describe("emit-only — nothing here files (scope 5)", () => {
  it("never writes an ope_id", async () => {
    for (const f of EXTRACTION_REJECT_FAMILIES) await emit(f);
    expect(rows()).toHaveLength(EXTRACTION_REJECT_FAMILIES.length);
    expect(rows().every((r) => r.ope_id === null)).toBe(true);
  });

  it("the eligibility query the CPI rail runs returns them", async () => {
    // "SELECT * FROM <fault table> WHERE status='open' AND ope_id IS NULL is
    // the query the cpi skill's Procedure A step 2 runs." Per OPE-811 the
    // canonical fileable set is {open, proposed, regressed}, and this emitter
    // writes `proposed` — so the widened query is what finds them.
    await emit("over-split");
    const eligible = raw
      .prepare(
        `SELECT * FROM extraction_faults WHERE status IN ('open','proposed','regressed') AND ope_id IS NULL`
      )
      .all();
    expect(eligible).toHaveLength(1);
  });
});

describe("the emitter never throws", () => {
  it("a broken ledger does not fail the reject that already happened", async () => {
    // The event is already REJECTED by the time this runs. Throwing would turn
    // a failed observation into a failed operator action.
    raw["exec"](`DROP TABLE extraction_faults`);
    await expect(emit("over-split")).resolves.toBeNull();
  });
});
