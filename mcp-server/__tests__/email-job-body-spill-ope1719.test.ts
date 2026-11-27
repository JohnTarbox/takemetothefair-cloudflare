/**
 * OPE-1719 — an email-jobs message must fit Cloudflare Queues' 128 KB limit.
 *
 * The Nov 27 weekend newsletter (88,126 chars of HTML) became a per-recipient
 * message of 136,334 bytes and `EMAIL_JOBS.send()` refused it (10204). The fix
 * spills an oversized body to `email_job_bodies` and enqueues `bodyRef`; the
 * consumer reads it back before it sends or ledgers.
 *
 * LANDMARKS: the fixture is first shown to be over the limit (or "the spilled
 * message fits" would pass on a fixture that never needed spilling), and the
 * small-message case asserts the message is returned untouched with zero rows
 * written (or "big messages spill" would pass on a helper that spills
 * everything).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import { emailSendLedger, emailJobBodies } from "../src/schema.js";
import {
  EMAIL_JOB_INLINE_LIMIT_BYTES,
  QUEUE_MESSAGE_LIMIT_BYTES,
  EmailJobTooLargeError,
  estimateQueueMessageBytes,
  spillEmailJobBody,
} from "@takemetothefair/db-schema/email-job-body";

const harness: { db: TestDb } = { db: null as unknown as TestDb };
const logError = vi.fn();
vi.mock("../src/db.js", () => ({ getDb: () => harness.db }));
vi.mock("../src/logger.js", () => ({ logError: (...a: unknown[]) => logError(...a) }));

const { handleEmailBatch } = await import("../src/queue-consumers.js");

beforeEach(() => {
  ({ db: harness.db } = createTestDb());
  logError.mockReset();
});

// Shape of the Nov 27 issue: ~88K chars of HTML with typographic punctuation
// (an em-dash makes V8 store the WHOLE string at two bytes per char), plus its
// text alternative.
const ROW = "<tr><td>Holiday Craft Fair — Saturday 9–3</td></tr>\n";
const bigHtml = ROW.repeat(Math.ceil(88_126 / ROW.length)).slice(0, 88_126);
const bigText = "Holiday Craft Fair — Saturday 9–3\n".repeat(1_000);
const bigMsg = () => ({
  to: "reader@example.com",
  subject: "This Weekend at the Fair — Nov 27",
  html: bigHtml,
  text: bigText,
  from: "Meet Me at the Fair <hello@meetmeatthefair.com>",
  source: "newsletter:weekly-digest",
  listUnsubscribe: "<https://meetmeatthefair.com/api/newsletter/unsubscribe?token=abc>",
  listUnsubscribePost: "List-Unsubscribe=One-Click",
});
// The DB type the helper wants is D1's; the better-sqlite3 test db has the
// same query-builder surface.
const db = () => harness.db as never;

describe("OPE-1719 — the size estimate", () => {
  it("LANDMARK: the Nov-27-shaped message is over the Queues limit unspilled", () => {
    expect(estimateQueueMessageBytes(bigMsg())).toBeGreaterThan(QUEUE_MESSAGE_LIMIT_BYTES);
  });

  it("counts a string with one non-Latin-1 char at two bytes per char", () => {
    const ascii = estimateQueueMessageBytes("a".repeat(1000));
    const wide = estimateQueueMessageBytes("a".repeat(999) + "—");
    expect(wide - ascii).toBe(1000);
  });
});

describe("OPE-1719 — spillEmailJobBody", () => {
  it("returns a small message untouched and writes nothing", async () => {
    const small = { to: "a@example.com", subject: "s", html: "<p>x</p>", text: "x", source: "t" };
    const out = await spillEmailJobBody(db(), small);
    expect(out).toBe(small);
    expect(await harness.db.select().from(emailJobBodies)).toHaveLength(0);
  });

  it("spills an oversized body: the message fits, the row holds the body", async () => {
    const out = await spillEmailJobBody(db(), bigMsg());
    expect(out.bodyRef).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.html).toBe("");
    expect(out.text).toBe("");
    expect(out.listUnsubscribe).toBe(bigMsg().listUnsubscribe);
    expect(estimateQueueMessageBytes(out)).toBeLessThanOrEqual(EMAIL_JOB_INLINE_LIMIT_BYTES);

    const rows = await harness.db.select().from(emailJobBodies);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(out.bodyRef);
    expect(rows[0].html).toBe(bigHtml);
    expect(rows[0].text).toBe(bigText);
  });

  it("refuses loudly when even the body-less message is too big", async () => {
    const msg = { ...bigMsg(), to: "x@example.com,".repeat(10_000) };
    await expect(spillEmailJobBody(db(), msg)).rejects.toBeInstanceOf(EmailJobTooLargeError);
    expect(await harness.db.select().from(emailJobBodies)).toHaveLength(0);
  });
});

describe("OPE-1719 — the consumer reads a spilled body back", () => {
  function batch(body: Record<string, unknown>) {
    const send = vi.fn(async () => ({ messageId: "<p-1@cf>" }));
    const msg = { id: "q-1719", attempts: 1, body, ack: vi.fn(), retry: vi.fn() };
    const env = { DB: {} as D1Database, EMAIL: { send } };
    return { send, msg, done: handleEmailBatch({ messages: [msg] } as never, env as never) };
  }

  it("sends the FULL body, ledgers it, deletes the spill row, acks", async () => {
    const spilled = await spillEmailJobBody(db(), bigMsg());
    const { send, msg, done } = batch({ ...spilled });
    await done;

    expect(send).toHaveBeenCalledTimes(1);
    const sentArg = (send.mock.calls[0] as unknown[])[0] as { html: string; text: string };
    expect(sentArg.html).toBe(bigHtml);
    expect(sentArg.text).toBe(bigText);
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();

    const ledger = await harness.db.select().from(emailSendLedger);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].status).toBe("sent");
    expect(ledger[0].bodyHtml).toBe(bigHtml);

    expect(await harness.db.select().from(emailJobBodies)).toHaveLength(0);
  });

  it("a missing spill row is retried, never sent as an empty email", async () => {
    const { send, msg, done } = batch({
      ...bigMsg(),
      html: "",
      text: "",
      bodyRef: "00000000-0000-0000-0000-000000000000",
    });
    await done;

    expect(send).not.toHaveBeenCalled();
    expect(msg.retry).toHaveBeenCalledTimes(1);
    expect(msg.ack).not.toHaveBeenCalled();
    const logged = logError.mock.calls.map((c) => c[1] as { level?: string; message?: string });
    expect(logged.some((l) => l.level === "error" && /not found/.test(l.message ?? ""))).toBe(true);
  });

  it("LANDMARK: an unspilled message still sends exactly as before", async () => {
    const { send, msg, done } = batch({
      to: "a@example.com",
      subject: "s",
      html: "<p>inline</p>",
      text: "inline",
      source: "t",
    });
    await done;
    expect(send).toHaveBeenCalledTimes(1);
    expect(((send.mock.calls[0] as unknown[])[0] as { html: string }).html).toBe("<p>inline</p>");
    expect(msg.ack).toHaveBeenCalledTimes(1);
  });
});
