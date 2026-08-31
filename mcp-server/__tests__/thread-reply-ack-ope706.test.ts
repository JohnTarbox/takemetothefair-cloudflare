/**
 * OPE-706 — the ack that told a customer nobody had read her, mid-conversation.
 *
 * Every header string below is a REAL value copied out of production
 * `inbound_emails` on 2026-08-31, not an invented shape. The regression this
 * guards is specific and was measurable before the fix: of the 19 rows carrying
 * any `in_reply_to`, only 5 name one of OUR message-ids. The other 14 are
 * forwards of third-party newsletters whose header names the newsletter's own
 * thread — and one of those 14 (`04f731ad`) is itself a `correction-ack`, i.e.
 * an ELIGIBLE KIND with a FOREIGN thread. A predicate keyed on "has an
 * in_reply_to" rather than "names our message-id" rewrites that one wrongly.
 * That row is the boundary and it is tested by value.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  shouldUseThreadReplyAck,
  THREAD_REPLY_OVERRIDABLE_KINDS,
} from "../src/email-handlers/thread-reply-ack.js";
import { buildReply } from "../src/email-reply-builder.js";

/** Real `in_reply_to` values naming our own message-ids (the 5 affected rows). */
const OURS = {
  emma: "<qgZx4ENu10VNStgyef2FLTX5bzIIwTlU1ZU0@meetmeatthefair.com>", // d1ad3eee/95adf412/c35b4919
  phillips: "<xZqMxWevomwTnNC7dBrcgBgO5dBqU9aQDbfB@meetmeatthefair.com>", // ef3bf7bd
  tammy: "<bLcVKadOha2DUcVnXzzOCzOPjKGF3jhegBPG@meetmeatthefair.com>", // c4d5a29b — the specimen
};

/** Real `in_reply_to` values from the 14 newsletter/forward rows. */
const FOREIGN = {
  gmailCorrection: "<CACUo==2bYqvr6hogE6MOpRWe3SrbmDV1wH+=Pus8Z04ENBpiGA@mail.gmail.com>", // 04f731ad
  outlook: "<SJ0PR18MB399571E1B87561885879A254BBCD2@SJ0PR18MB3995.namprd18.prod.outlook.com>",
  mailerlite: "<0caacfe34403d700267b92c548b46a96@mlsend.com>",
  mailchimp:
    "<7c3150af907fd3c229dbc1712.b4439b3791.20260730002128.d1b01792df.be13ca5d@mail140.atl271.mcdlv.net>",
  google: "<2dcedd8527da7103c4af0137ecf1e31dc5cf2371-20144934-110888203@google.com>",
};

describe("the specimen: a reply on a thread a person is already in", () => {
  it("overrides support-ack for Tammy's 08-31 reply", () => {
    // She was answering "which fair?" — a question a person had asked her the
    // day before. The default copy would have told her nobody had read it.
    expect(shouldUseThreadReplyAck("support-ack", OURS.tammy, null)).toBe(true);
  });

  it("overrides correction-ack for Emma's reply", () => {
    expect(shouldUseThreadReplyAck("correction-ack", OURS.emma, null)).toBe(true);
  });

  it("matches on References when In-Reply-To is absent", () => {
    // Some clients thread on References only; both headers are consulted.
    expect(shouldUseThreadReplyAck("support-ack", null, OURS.phillips)).toBe(true);
  });
});

describe("the 14 forwards must ack exactly as they do today", () => {
  it("does NOT override a correction-ack whose thread is a Gmail one", () => {
    // 04f731ad — the boundary row. Eligible KIND, foreign THREAD. If this ever
    // returns true, the predicate has been loosened to "has an in_reply_to" and
    // 14 legitimate acks are being silently rewritten.
    expect(shouldUseThreadReplyAck("correction-ack", FOREIGN.gmailCorrection, null)).toBe(false);
  });

  it.each(Object.entries(FOREIGN))(
    "does not fire on the %s newsletter thread",
    (_label, header) => {
      expect(shouldUseThreadReplyAck("support-ack", header, null)).toBe(false);
      expect(shouldUseThreadReplyAck("correction-ack", null, header)).toBe(false);
    }
  );

  it("does not fire when there are no threading headers at all", () => {
    // 363 of 420 rows. A fresh submission must be untouched.
    expect(shouldUseThreadReplyAck("support-ack", null, null)).toBe(false);
    expect(shouldUseThreadReplyAck("support-ack", "", "")).toBe(false);
  });
});

describe("the kind gate is as narrow as it claims", () => {
  it("leaves every other reply kind alone even on our own thread", () => {
    // The ruling says the default ack is untouched for every other row. These
    // kinds make no claim a prior human reply falsifies, so rewording them
    // would be scope the ticket did not ask for.
    for (const kind of [
      "ok",
      "ok-multi",
      "no-url",
      "photo-intake-ack",
      "unsubscribe-ack",
    ] as const) {
      expect(shouldUseThreadReplyAck(kind, OURS.tammy, null)).toBe(false);
    }
  });

  it("exposes exactly the two kinds the measured rows produced", () => {
    expect([...THREAD_REPLY_OVERRIDABLE_KINDS].sort()).toEqual(["correction-ack", "support-ack"]);
  });

  it("does nothing when there is no reply at all", () => {
    expect(shouldUseThreadReplyAck(null, OURS.tammy, null)).toBe(false);
  });
});

describe("domain matching is not a substring match", () => {
  it("rejects a lookalike domain that merely ends with ours", () => {
    // `notmeetmeatthefair.com` contains our domain as a suffix. The helper
    // requires the `@` to be followed by our domain or a subdomain of it.
    expect(shouldUseThreadReplyAck("support-ack", "<x@notmeetmeatthefair.com>", null)).toBe(false);
  });

  it("accepts a subdomain, which the ticket's SQL would have missed", () => {
    // `in_reply_to LIKE '%@meetmeatthefair.com%'` does not match this; the
    // shared helper does. Reusing the helper rather than the ticket's SQL is
    // what buys this.
    expect(shouldUseThreadReplyAck("support-ack", "<x@mail.meetmeatthefair.com>", null)).toBe(true);
  });
});

describe("the approved copy", () => {
  // Through the real public builder, so the widget/stale-note pipeline the
  // workflow uses is exercised rather than the raw template string.
  const body = buildReply("thread-reply-ack", "someone@example.com", {}).text;

  it("renders the wording approved 2026-08-31, verbatim", () => {
    expect(body).toBe(
      `Thanks for writing back.

This is an automatic note to confirm your reply reached us — there's no need to send it again. It's attached to your existing thread, and it's gone to the person you've been corresponding with.

— Meet Me at the Fair`
    );
  });

  it("makes no claim about whether a person has read the message", () => {
    // The defect sentence, and any softened variant of it. This is the one
    // assertion that must never come back into this template.
    expect(body).not.toMatch(/read by a person/i);
    expect(body).not.toMatch(/hasn't been read/i);
    expect(body).not.toMatch(/automatic reply/i);
  });

  it("promises nothing about when a human will respond", () => {
    // OPE-367's constraint still binds: the support-obligations queue is not
    // drained, so a timing promise would be a fact nothing keeps.
    expect(body).not.toMatch(/\b(soon|shortly|within|\d+\s*(hours?|days?|business))\b/i);
    expect(body).not.toMatch(/will (get back|respond|reply)/i);
  });
});

/**
 * The predicate above is pure and easy to test. That is exactly why it needs
 * this block: a correct, fully-tested helper that nothing calls is the defect
 * shape this codebase has shipped repeatedly — `findPriorAdjudication` (13
 * tests, 0 callers), `detectChallengePage` (91 tests, 0 callers), OPE-236's
 * claim-recording (present on 3 of 6 paths). A green suite is not evidence a
 * feature is live.
 *
 * These assertions read the workflow source, because the workflow itself is not
 * unit-testable here (Durable-Object step runner + live EMAIL binding).
 */
describe("the override is actually wired into the send path", () => {
  const workflow = readFileSync(
    join(__dirname, "..", "src", "workflows", "inbound-email.ts"),
    "utf8"
  );

  it("calls the predicate — anchored on call syntax, not the bare symbol", () => {
    // `indexOf("shouldUseThreadReplyAck")` would match the IMPORT line and go
    // vacuously green while nothing invoked it.
    expect(workflow).toMatch(/shouldUseThreadReplyAck\s*\(/);
  });

  it("selects both header columns in the send-reply step", () => {
    // Without these the predicate receives undefined on every message and
    // silently never fires — the failure would look exactly like "no affected
    // rows", which is indistinguishable from success.
    expect(workflow).toMatch(/inReplyTo:\s*inboundEmails\.inReplyTo/);
    expect(workflow).toMatch(/emailReferences:\s*inboundEmails\.emailReferences/);
  });

  it("runs the override BEFORE the reply is built", () => {
    // Order is load-bearing: overriding after buildReply would render the old
    // template and change only the logged kind.
    const call = workflow.indexOf("shouldUseThreadReplyAck(");
    const build = workflow.indexOf("buildReply(replyKind");
    expect(call).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(-1);
    expect(call).toBeLessThan(build);
  });

  it("runs the override BEFORE the receipt-widget branch", () => {
    // The widget branch switches on `replyKind` and appends content to the
    // email. Overriding after it would attach a "was this what you wanted?"
    // block to copy that is approved verbatim and does not mention one.
    const call = workflow.indexOf("shouldUseThreadReplyAck(");
    const widget = workflow.indexOf("RECEIPT_WIDGET_KINDS.includes(replyKind)");
    expect(widget).toBeGreaterThan(-1);
    expect(call).toBeLessThan(widget);
  });

  it("does not add the new kind to the widget or correction-form allowlists", () => {
    // Adding a ReplyKind without checking these two lists is a known trap in
    // this repo. `thread-reply-ack` belongs in neither: its copy is fixed and
    // approved, and it has no event to correct.
    const widgetList = workflow.slice(
      workflow.indexOf("const RECEIPT_WIDGET_KINDS"),
      workflow.indexOf("const RECEIPT_WIDGET_KINDS") + 1200
    );
    expect(widgetList).not.toMatch(/"thread-reply-ack"/);
  });
});
