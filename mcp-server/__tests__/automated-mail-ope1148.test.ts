/**
 * OPE-1148 — machine mail is held: no ack, no event.
 *
 * The replay below is the 16 rows submit@ received between 22:55 and 01:36 UTC
 * on 2026-09-23/24, rebuilt from the columns prod STORED (from address,
 * sending host, arrival time). The raw headers were never stored, so the
 * replay runs twice: once with no headers at all (what the stored data alone
 * proves), and once with the `X-Forwarded-For` Gmail stamps on every
 * auto-forwarded message (what the real headers would have carried).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createTestDb, type TestDb } from "./setup-db.js";
import {
  detectAutomatedMail,
  burstTripped,
  isBurstCrossing,
  isZeroConfidenceUnclear,
  automationHeadersJson,
  DEFAULT_BURST_THRESHOLDS,
} from "../src/email-handlers/automated-mail.js";
import {
  checkInboundBurst,
  readBurstThresholds,
  insertAuditNoopRow,
} from "../src/email-handler.js";
import { inboundEmails, tunableThresholds } from "../src/schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, "..", rel), "utf8");

const headers = (h: Record<string, string>) => ({
  get: (k: string) => {
    const hit = Object.entries(h).find(([key]) => key.toLowerCase() === k.toLowerCase());
    return hit ? hit[1] : null;
  },
});
const NONE = headers({});

const GMAIL_FWD = "x08-02.v6.unverified-forwarding.1e100.net";
const GMAIL = "mail-dl2-x0f.google.com";

// id, from, sending host, UTC time, historical outcome
const INCIDENT: [string, string, string, string, string][] = [
  ["7b41cb18", "forwarding-noreply@google.com", GMAIL, "2026-09-23T22:55:00Z", "classifier spam"],
  ["7b15cf18", "calendar-notification@google.com", GMAIL_FWD, "2026-09-23T23:10:00Z", "ACKED"],
  ["dfbfaf58", "groupupdates@facebookmail.com", GMAIL_FWD, "2026-09-23T23:36:00Z", "ACKED"],
  ["81d2722b", "moveon-help@list.moveon.org", GMAIL_FWD, "2026-09-23T23:40:00Z", "ACKED"],
  ["4007aa77", "calendar-notification@google.com", GMAIL_FWD, "2026-09-23T23:50:00Z", "ACKED"],
  ["765a0297", "noreply@groups.io", GMAIL, "2026-09-23T23:55:00Z", "audit-noop"],
  ["b22d453a", "noreply@groups.io", GMAIL, "2026-09-24T00:00:00Z", "audit-noop"],
  [
    "047bd309",
    "follow-suggestions@mail.instagram.com",
    GMAIL_FWD,
    "2026-09-24T00:00:30Z",
    "classifier spam",
  ],
  [
    "8d2046d1",
    "functions@momath.org",
    "mail-dl1-x122e.google.com",
    "2026-09-24T00:18:00Z",
    "ACKED",
  ],
  [
    "35a6fcdc",
    "updates-noreply@linkedin.com",
    "mail-dl2-x10.google.com",
    "2026-09-24T00:51:00Z",
    "classifier spam",
  ],
  ["17b6c4c7", "info@fsf.org", "mail-dy2-x10.google.com", "2026-09-24T00:57:00Z", "ACKED"],
  [
    "c1db0a59",
    "usaa.customer.service@omem.usaa.com",
    GMAIL,
    "2026-09-24T00:58:00Z",
    "classifier spam",
  ],
  ["5608c92a", "feedback@e.democrats.org", GMAIL, "2026-09-24T01:07:00Z", "classifier spam"],
  [
    "034570a9",
    "premium@academia-mail.com",
    "mail-dl2-x10.google.com",
    "2026-09-24T01:16:00Z",
    "ACKED",
  ],
  ["d1f5619f", "no-reply@email.claude.com", GMAIL, "2026-09-24T01:18:00Z", "audit-noop"],
  ["b1b984be", "pageupdates@facebookmail.com", GMAIL_FWD, "2026-09-24T01:36:00Z", "ACKED"],
];

let db: TestDb;
beforeEach(() => {
  ({ db } = createTestDb());
});

/** The handler's decision order: detector first, then the burst breaker, each
 *  message persisted before the next arrives (held or not), exactly as the
 *  handler inserts a row per message. */
async function replay(withForwardHeaders: boolean) {
  const outcome = new Map<string, string>();
  for (const [id, from, host, at, historical] of INCIDENT) {
    const now = new Date(at);
    const fwd = withForwardHeaders && id !== "7b41cb18"; // the confirmation came direct
    const verdict = detectAutomatedMail({
      headers: fwd
        ? headers({ "X-Forwarded-For": "jtarboxme@gmail.com submit@meetmeatthefair.com" })
        : NONE,
      fromAddr: from,
      sendingHost: host,
    });
    let decided: string;
    if (verdict) decided = `held:${verdict.kind}`;
    else {
      const burst = await checkInboundBurst(db as never, "submit@meetmeatthefair.com", from, now);
      decided = burst.tripped ? "held:burst" : `proceeds (historically ${historical})`;
    }
    outcome.set(id, decided);
    db.insert(inboundEmails)
      .values({
        id,
        receivedAt: now,
        fromAddress: from,
        toAddress: "submit@meetmeatthefair.com",
        intent: "submit",
        status: decided.startsWith("held") ? "held-automated" : "received",
        createdAt: now,
      } as never)
      .run();
  }
  return outcome;
}

describe("OPE-1148 — the 2026-09-23 replay", () => {
  it("ACCEPTANCE (real headers): every message is held — zero would reach a send or an event", async () => {
    const out = await replay(true);
    const proceeding = [...out].filter(([, d]) => !d.startsWith("held"));
    expect(proceeding).toEqual([]);
    expect(out.get("7b41cb18")).toBe("held:forwarding-confirmation");
  });

  it("stored columns alone: every ACKED row but one is held, and the one is named", async () => {
    const out = await replay(false);
    const ackedAndProceeding = INCIDENT.filter(
      ([id, , , , hist]) => hist === "ACKED" && !out.get(id)!.startsWith("held")
    ).map(([id, from]) => `${id} ${from}`);
    // FSF arrived via an ordinary Gmail host in a quiet window. Without its
    // real headers (X-Forwarded-For, and a bulk sender's List-Unsubscribe),
    // nothing stored identifies it. Pinned so the gap is visible, not hidden.
    expect(ackedAndProceeding).toEqual(["17b6c4c7 info@fsf.org"]);
    // MoMath had no automation signal either — the burst breaker held it.
    expect(out.get("8d2046d1")).toBe("held:burst");
  });
});

describe("OPE-1148 — the detector, rule by rule", () => {
  const d = (from: string, h = NONE, host: string | null = GMAIL) =>
    detectAutomatedMail({ headers: h, fromAddr: from, sendingHost: host });

  it.each([
    [
      "Auto-Submitted: auto-generated",
      { "Auto-Submitted": "auto-generated" },
      "header:auto-submitted=auto-generated",
    ],
    ["Precedence: bulk", { Precedence: "bulk" }, "header:precedence=bulk"],
    ["List-Id", { "List-Id": "<news.fair.org>" }, "header:list-id"],
    ["List-Unsubscribe", { "List-Unsubscribe": "<mailto:u@x>" }, "header:list-unsubscribe"],
  ])("%s holds", (_n, h, reason) => {
    expect(d("events@somefair.org", headers(h))?.reason).toBe(reason);
  });

  it("Auto-Submitted: no is a human", () => {
    expect(d("events@somefair.org", headers({ "Auto-Submitted": "no" }))).toBeNull();
  });

  it("REGRESSION: a genuine organizer email with no automated signal proceeds", () => {
    expect(d("secretary@fryeburgfair.org")).toBeNull();
    expect(d("maryjane.smith@gmail.com")).toBeNull();
  });

  it.each([
    "noreplyfan@x.com",
    "notifyme@x.com",
    "bounce.house@funrentals.com",
    "bounce-rentals@x.com",
  ])("a person or vendor whose address merely contains a robot word proceeds: %s", (from) => {
    expect(d(from)).toBeNull();
  });

  it.each([
    ["updates-noreply@linkedin.com", "relay-domain:linkedin.com"],
    ["sc-noreply@google.com", "robot-local-token:noreply"],
    ["calendar-notification@google.com", "sender:calendar-notification@google.com"],
    ["no-reply@email.claude.com", "robot-local:no-reply"],
    ["mailer-daemon@mx.example.com", "robot-local:mailer-daemon"],
    ["groupupdates@facebookmail.com", "relay-domain:facebookmail.com"],
  ])("%s holds (%s)", (from, reason) => {
    expect(d(from)?.reason).toBe(reason);
  });

  it("a hand forward from the operator (no X-Forwarded-For, ordinary host) proceeds", () => {
    expect(d("jtarboxme@gmail.com", NONE, "mail-dl2-x0f.google.com")).toBeNull();
  });

  it("a forwarding confirmation is its own kind, so it alerts instead of holding quietly", () => {
    expect(d("forwarding-noreply@google.com")?.kind).toBe("forwarding-confirmation");
  });

  it("automationHeadersJson captures only what is present", () => {
    expect(automationHeadersJson(NONE)).toBeNull();
    expect(
      JSON.parse(automationHeadersJson(headers({ "List-Id": "<a>", Precedence: "bulk" }))!)
    ).toEqual({
      Precedence: "bulk",
      "List-Id": "<a>",
    });
  });
});

describe("OPE-1148 — the burst breaker", () => {
  const T = DEFAULT_BURST_THRESHOLDS;

  it("one person sending a dozen messages in an hour — John's normal busy hour — never trips", () => {
    expect(burstTripped({ messages: 12, senders: 1 }, T)).toBe(false);
  });

  it("trips only above BOTH limits", () => {
    expect(burstTripped({ messages: 7, senders: 5 }, T)).toBe(true);
    expect(burstTripped({ messages: 6, senders: 6 }, T)).toBe(false);
    expect(burstTripped({ messages: 20, senders: 4 }, T)).toBe(false);
  });

  it("alerts exactly once: on the transition, not on every later message", () => {
    expect(isBurstCrossing({ messages: 7, senders: 5 }, true, T)).toBe(true);
    // a later message from a sender already in the window: still tripped, no alert
    expect(isBurstCrossing({ messages: 8, senders: 5 }, false, T)).toBe(false);
    expect(isBurstCrossing({ messages: 9, senders: 6 }, true, T)).toBe(false);
  });

  it("reads thresholds from tunable_thresholds (tunable without a deploy), falling back per key", async () => {
    expect(await readBurstThresholds(db as never)).toEqual(T);
    db.insert(tunableThresholds)
      .values({
        key: "inbound_burst_max_senders",
        value: 2,
        unit: "senders",
        updatedAt: new Date(),
      } as never)
      .run();
    expect(await readBurstThresholds(db as never)).toEqual({ ...T, maxSenders: 2 });
  });
});

describe("OPE-1148 item 6 — zero-confidence unclear gets no ack", () => {
  it.each([
    ["unclear", 0, true],
    ["unclear", null, true],
    ["unclear", 0.4, false],
    ["new_event", 0, false],
    [null, null, false],
  ])("%s @ %s → suppress=%s", (i, c, want) => {
    expect(isZeroConfidenceUnclear(i as string | null, c as number | null)).toBe(want);
  });
});

describe("OPE-1148 — held rows are stored, findable and salvageable", () => {
  it("a held row is terminal (no workflow), carries its reason, and flags operator-relevant kinds", async () => {
    await insertAuditNoopRow(db as never, {
      fromAddr: "forwarding-noreply@google.com",
      toAddr: "submit@meetmeatthefair.com",
      subject: "Gmail Forwarding Confirmation",
      bodyTextExcerpt: "x",
      bodyTextStored: "x",
      bodyHtmlStored: null,
      senderSignals: {} as never,
      senderIdentity: {} as never,
      threadColumns: {} as never,
      attachmentCount: 0,
      rawSize: 1,
      messageId: "<fc@x>",
      reason: "forwarding-confirmation:forwarding-noreply@google.com",
      disposition: {
        intent: "held-automated",
        status: "held-automated",
        routingSource: "automated:forwarding-confirmation",
        flagged: 1,
      },
    });
    const [r] = await db.select().from(inboundEmails);
    expect(r.status).toBe("held-automated");
    expect(r.flaggedForReview).toBe(1);
    expect(r.workflowInstanceId).toBeNull();
    expect(r.extractFailReason).toBe("forwarding-confirmation:forwarding-noreply@google.com");
  });
});

describe("OPE-1148 — wiring", () => {
  const handler = read("src/email-handler.ts");
  it("the gate runs before the workflow is created, and both held paths return", () => {
    const gate = handler.indexOf("const automated = detectAutomatedMail({");
    const burst = handler.indexOf(
      "const burst = await checkInboundBurst(getDb(env.DB), toAddr, fromAddr);"
    );
    const workflow = handler.indexOf("const instance = await env.INBOUND_EMAIL.create({");
    expect(gate).toBeGreaterThan(-1);
    expect(burst).toBeGreaterThan(gate);
    expect(workflow).toBeGreaterThan(burst);
  });
  it("the forwarding confirmation is forwarded to the operator as an alert", () => {
    expect(handler).toMatch(
      /if \(automated\.kind === "forwarding-confirmation"\) \{\s*\/\/[^\n]*\n[^\n]*\n\s*await forwardToAdminBestEffort\(message, env, "forwarding-confirmation", sessionId\);/
    );
  });
  it("the workflow suppresses a zero-confidence unclear ack before send-reply", () => {
    const wf = read("src/workflows/inbound-email.ts");
    const guard = wf.indexOf('"reply-guard/zero-confidence-unclear"');
    const send = wf.indexOf('"send-reply"');
    expect(guard).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(guard);
  });
});
