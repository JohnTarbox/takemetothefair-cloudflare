/**
 * OPE-407 — content-free detection and burst collapse.
 *
 * The shapes below are the real prod rows, not invented ones. Replaying this
 * rule across all 268 inbound rows carrying a raw_size selected exactly the
 * seven the ticket names and nothing else, so the cases that matter most here
 * are the NEGATIVE ones: the legitimate URL-less prose submissions from the same
 * sender that must keep their existing handling.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import { inboundEmails } from "../src/schema.js";
import {
  isContentFreeEmail,
  assessContentFreeBurst,
  countContentFreeBurst,
  EMPTY_RAW_SIZE_MAX_BYTES,
} from "../src/email-handlers/empty-message.js";

let db: TestDb;
beforeEach(() => {
  ({ db } = createTestDb());
});

const SENDER = "jtarboxme@gmail.com";
const T0 = new Date("2026-08-15T23:22:38Z");

/** The exact shape of the six 2026-08-15 rows: body "\n\n", no subject, no
 *  attachment, ~7.1 KB of bare Gmail headers. */
async function seedEmpty(id: string, offsetSeconds: number, from = SENDER) {
  await db.insert(inboundEmails).values({
    id,
    receivedAt: new Date(T0.getTime() + offsetSeconds * 1000),
    fromAddress: from,
    toAddress: "submit@meetmeatthefair.com",
    subject: null,
    bodyTextExcerpt: "\n\n",
    attachmentCount: 0,
    rawSize: 7096,
    intent: "submit",
    status: "processing",
    createdAt: new Date(T0.getTime() + offsetSeconds * 1000),
  });
}

describe("isContentFreeEmail", () => {
  it("detects the observed shape: no body, no subject, no attachment", () => {
    expect(
      isContentFreeEmail({ bodyText: "\n\n", subject: null, attachmentCount: 0, rawSize: 7096 })
    ).toBe(true);
  });

  it("does NOT flag a legitimate URL-less prose submission", () => {
    // 252e62ef… "Lovell Old Home Days" — 79 chars, answered ok-low. The whole
    // point of the rule keying on content rather than on a missing attachment.
    expect(
      isContentFreeEmail({
        bodyText: "Lovell Old Home Days is July 25-27 at the town common in Lovell, Maine.",
        subject: null,
        attachmentCount: 0,
        rawSize: 8200,
      })
    ).toBe(false);
  });

  it("does NOT flag a message that carried an attachment", () => {
    expect(
      isContentFreeEmail({ bodyText: "", subject: null, attachmentCount: 1, rawSize: 500_000 })
    ).toBe(false);
  });

  it("does NOT flag a message whose subject carries the content", () => {
    // A photo emailed with only "Waterford World's Fair" in the subject is a
    // usable submission — the photo lane resolves the fair from exactly that.
    expect(
      isContentFreeEmail({
        bodyText: "",
        subject: "Waterford World's Fair",
        attachmentCount: 0,
        rawSize: 7100,
      })
    ).toBe(false);
  });

  it("refuses to claim emptiness for a message that was carrying weight", () => {
    // The guard against blaming the sender for OUR parse failure: prod holds
    // rows of 70–81 KB that recorded zero body, zero html, zero attachments.
    expect(
      isContentFreeEmail({
        bodyText: "",
        subject: null,
        attachmentCount: 0,
        rawSize: EMPTY_RAW_SIZE_MAX_BYTES + 1,
      })
    ).toBe(false);
  });

  it("still detects when raw_size is unknown — a missing measurement is not counter-evidence", () => {
    expect(
      isContentFreeEmail({ bodyText: "\n\n", subject: null, attachmentCount: 0, rawSize: null })
    ).toBe(true);
  });

  it("treats a whitespace-only subject as no subject", () => {
    expect(
      isContentFreeEmail({ bodyText: "", subject: "   ", attachmentCount: 0, rawSize: 7000 })
    ).toBe(true);
  });
});

describe("burst collapse", () => {
  it("elects exactly ONE leader out of the six-in-48-seconds burst", async () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const offsets = [0, 8, 20, 30, 40, 48];
    for (let i = 0; i < ids.length; i++) await seedEmpty(ids[i], offsets[i]);

    const leaders: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      const { isLeader } = await assessContentFreeBurst(db, {
        id: ids[i],
        fromAddress: SENDER,
        receivedAt: new Date(T0.getTime() + offsets[i] * 1000),
      });
      if (isLeader) leaders.push(ids[i]);
    }
    expect(leaders).toEqual(["a"]);
  });

  it("the leader counts the whole burst, not just itself", async () => {
    const offsets = [0, 8, 20, 30, 40, 48];
    for (let i = 0; i < offsets.length; i++) await seedEmpty(`m${i}`, offsets[i]);
    expect(await countContentFreeBurst(db, { fromAddress: SENDER, receivedAt: T0 })).toBe(6);
  });

  it("a message outside the window starts its own burst", async () => {
    await seedEmpty("first", 0);
    await seedEmpty("later", 20 * 60); // 20 minutes on
    const { isLeader } = await assessContentFreeBurst(db, {
      id: "later",
      fromAddress: SENDER,
      receivedAt: new Date(T0.getTime() + 20 * 60 * 1000),
    });
    expect(isLeader).toBe(true);
  });

  it("a different sender's empty message does not join the burst", async () => {
    await seedEmpty("mine", 0);
    await seedEmpty("theirs", 5, "someone-else@example.com");
    expect(await countContentFreeBurst(db, { fromAddress: SENDER, receivedAt: T0 })).toBe(1);
  });

  it("does not count the sender's legitimate prose submissions", async () => {
    await seedEmpty("empty1", 0);
    await db.insert(inboundEmails).values({
      id: "prose",
      receivedAt: new Date(T0.getTime() + 10_000),
      fromAddress: SENDER,
      toAddress: "submit@meetmeatthefair.com",
      subject: null,
      bodyTextExcerpt: "North Country Moose Festival, Colebrook NH, August 22-24.",
      attachmentCount: 0,
      rawSize: 8400,
      intent: "submit",
      status: "processing",
      createdAt: new Date(T0.getTime() + 10_000),
    });
    expect(await countContentFreeBurst(db, { fromAddress: SENDER, receivedAt: T0 })).toBe(1);
  });

  it("breaks a same-second tie on id, so two rows never both lead", async () => {
    await seedEmpty("bbb", 0);
    await seedEmpty("aaa", 0);
    const first = await assessContentFreeBurst(db, {
      id: "aaa",
      fromAddress: SENDER,
      receivedAt: T0,
    });
    const second = await assessContentFreeBurst(db, {
      id: "bbb",
      fromAddress: SENDER,
      receivedAt: T0,
    });
    expect([first.isLeader, second.isLeader]).toEqual([true, false]);
  });

  it("never reports a burst of zero", async () => {
    // Defensive: the leader's own row is in the burst by definition, but a
    // notice reading "0 emails arrived" would be nonsense if a read raced.
    expect(await countContentFreeBurst(db, { fromAddress: SENDER, receivedAt: T0 })).toBe(1);
  });
});
