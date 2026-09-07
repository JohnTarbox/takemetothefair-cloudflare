/**
 * OPE-832 — a bug described in an email reaches the defect queue.
 *
 * Every specimen below is REAL prod text, taken verbatim from `inbound_emails`
 * on 2026-09-07 (personal names removed). That matters: the first version of
 * the measurement query that found them used a straight apostrophe and MISSED
 * the ticket's own headline specimen, because the sender's phone wrote `doesn’t`
 * with U+2019. A detector built and tested on hand-typed strings would have
 * shipped looking correct and never fired on a single real report.
 *
 * ⚠️ Driven to failure before being kept (OPE-6 v3.8).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import {
  detectDefectReport,
  normalizeForDefectMatch,
  DEFECT_PHRASE_COUNT,
} from "../src/email-handlers/defect-language.js";
import { recordDefectCandidate } from "../src/email-handlers/defect-candidate.js";
import { problemReports } from "../src/schema.js";
import { eq } from "drizzle-orm";

// --- real prod bodies, verbatim (names removed) -------------------------

/** 4c4fe4f5, 2026-09-06, notify@ — the ticket's headline specimen. Note U+2019. */
const JOE = `I just tried to fill out my Vendor profile on your website and even when I
hit “save changes” and it says it’s saved it still doesn’t save. Only the
photo I uploaded saves.

I’m on an old iPhone maybe that’s the issue?`;

/** 1b65e94a, 2026-08-10, hello@ */
const SIGNUP_BUG = `Hello, I am reaching out to let you know that there is an issue with your
account sign up page. I am trying to make an account with you on my iPhone
and the page to make an account appears to be bugged in some way.`;

/** cae4be85, 2026-07-09, support@ */
const REGISTER_ERROR = `Good afternoon,

I am trying to make an account on Create your account | Meet Me at the Fair
<https://meetmeatthefair.com/register>. But when I click "create account,"
I'm getting an error message at the top asking me to compete the form.`;

/** d7ee53e0, 2026-07-09, submit@ — the NEGATIVE specimen the acceptance asks
 *  for. A real forwarded vendor-application update: ordinary English about a
 *  person declining, not a system failing. */
const NOT_A_DEFECT = `Thank you for your interest in participating in Art in the Park and for
taking the time to submit an application.

We wanted to clarify that the Microsoft Form served as a vendor application
and was not a confirmation of acceptance into the event. Applications closed
earlier this year, and our vendor selection process was completed in March.
We were unable to accommodate every applicant.`;

describe("OPE-832 — apostrophe normalisation is load-bearing, not cosmetic", () => {
  it("folds U+2019 so a phone-composed report still matches", () => {
    expect(normalizeForDefectMatch("it doesn’t save")).toContain("doesn't save");
  });

  it("detects the headline specimen, which uses curly apostrophes throughout", () => {
    const d = detectDefectReport(JOE);
    expect(d.isDefect).toBe(true);
    expect(d.matched).toContain("doesn't save");
  });

  it("a straight-apostrophe-only matcher would have missed it — the regression pinned", () => {
    // Reproduce the exact failure, not its neighbourhood: the raw text does NOT
    // contain the ASCII phrase, so anything matching without normalising is
    // blind to it. If normalisation is ever dropped, the test above goes red
    // and this one explains why.
    expect(JOE.toLowerCase().includes("doesn't save")).toBe(false);
    expect(JOE.toLowerCase().includes("doesn’t save")).toBe(true);
  });
});

describe("OPE-832 — precision over recall on the real 180-day corpus", () => {
  it("flags all three real defect reports", () => {
    expect(detectDefectReport(JOE).isDefect).toBe(true);
    expect(detectDefectReport(SIGNUP_BUG).isDefect).toBe(true);
    expect(detectDefectReport(REGISTER_ERROR).isDefect).toBe(true);
  });

  it("does NOT flag the forwarded vendor-application update", () => {
    // "unable to accommodate" is a person declining, not a system failing.
    // This is why "unable to" is deliberately absent from the phrase list.
    const d = detectDefectReport(NOT_A_DEFECT);
    expect(d.matched).toEqual([]);
    expect(d.isDefect).toBe(false);
  });

  it("does not flag ordinary support questions", () => {
    expect(detectDefectReport("How do I apply to the Fryeburg Fair?").isDefect).toBe(false);
    expect(detectDefectReport("Can you add my booth to the vendor list?").isDefect).toBe(false);
    expect(detectDefectReport("").isDefect).toBe(false);
    expect(detectDefectReport(null).isDefect).toBe(false);
  });

  it("the phrase corpus is non-trivial — a positive landmark for the negatives above", () => {
    // "nothing matched" proves nothing if the list is empty or got truncated.
    expect(DEFECT_PHRASE_COUNT).toBeGreaterThanOrEqual(20);
  });
});

describe("OPE-832 — recordDefectCandidate writes a CANDIDATE, not a defect", () => {
  let db: TestDb;
  beforeEach(() => {
    ({ db } = createTestDb());
  });

  const args = {
    inboundEmailId: "inbound-1",
    intent: "support",
    subject: "Re: Selling my book",
    bodyText: JOE,
    fromAddress: "Vendor Person <vendor@example.com>",
  };

  it("creates a row with kind=defect_candidate, linked to the inbound email", async () => {
    const out = await recordDefectCandidate(db, args);
    expect(out.status).toBe("created");

    const rows = db.select().from(problemReports).all();
    expect(rows).toHaveLength(1);
    // NOT "defect": list_problem_reports defaults to kind:"defect", so a
    // candidate must not inflate the queue this ticket exists to make
    // trustworthy. It still surfaces via the tool's open_other_kinds summary.
    expect(rows[0].kind).toBe("defect_candidate");
    expect(rows[0].source).toBe("email");
    expect(rows[0].inboundEmailId).toBe("inbound-1");
    expect(rows[0].reporterEmail).toBe("vendor@example.com");
    // The reviewer can judge the call without reopening the email.
    expect(rows[0].body).toContain("matched: doesn't save");
  });

  it("is idempotent — a workflow retry or redelivery writes nothing new", async () => {
    await recordDefectCandidate(db, args);
    const second = await recordDefectCandidate(db, args);
    expect(second.status).toBe("already-reported");
    expect(db.select().from(problemReports).all()).toHaveLength(1);
  });

  it("never double-files on top of the report@ handler's own row", async () => {
    // The report@/feedback@ path creates a real `defect` row in its handler.
    // Double-filing on top of it is literally the bug OPE-769 was filed about.
    db.insert(problemReports)
      .values({
        id: "pre-existing",
        body: "filed by the report@ handler",
        source: "email",
        inboundEmailId: "inbound-1",
        severity: "LOW",
        createdAt: new Date(),
      })
      .run();
    const out = await recordDefectCandidate(db, args);
    expect(out.status).toBe("already-reported");
    const rows = db
      .select()
      .from(problemReports)
      .where(eq(problemReports.inboundEmailId, "inbound-1"))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("pre-existing");
  });

  it("skips the intents that already file their own, and spam", async () => {
    expect((await recordDefectCandidate(db, { ...args, intent: "problem_report" })).status).toBe(
      "intent-skipped"
    );
    expect((await recordDefectCandidate(db, { ...args, intent: "spam" })).status).toBe(
      "intent-skipped"
    );
    expect(db.select().from(problemReports).all()).toHaveLength(0);
  });

  it("examines intents beyond support — the specimens arrived under two", async () => {
    // The measured corpus arrived at notify@ / hello@ / support@ / submit@.
    // An allow-list of "the intents bugs arrive under" would be a guess at a
    // distribution of three.
    for (const intent of ["support", "vendor_inquiry", "unclear", "unknown", "new_event"]) {
      ({ db } = createTestDb());
      const out = await recordDefectCandidate(db, { ...args, intent });
      expect(out.status, `intent=${intent}`).toBe("created");
    }
  });

  it("writes nothing when the body carries no defect language", async () => {
    const out = await recordDefectCandidate(db, {
      ...args,
      bodyText: NOT_A_DEFECT,
      subject: "Fwd",
    });
    expect(out.status).toBe("no-defect-language");
    expect(db.select().from(problemReports).all()).toHaveLength(0);
  });
});
