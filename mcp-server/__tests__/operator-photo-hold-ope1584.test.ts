/**
 * OPE-1584 — ten operator uploads with no GPS: zero immediate emails, one line
 * in the next digest. External senders keep the hold notice.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "./setup-db.js";
import { isOperatorAddress } from "../src/test-addresses.js";
import { checkOperatorQueues, readOperatorQueues } from "../src/operator-queue-notice.js";

const NOW = new Date("2026-11-01T06:00:00Z");
const OPERATOR = "admin@takemetothefair.com";
let raw: ReturnType<typeof createTestDb>["raw"];
let db: ReturnType<typeof createTestDb>["db"];
let n = 0;

function held(from: string, at: Date, extra: { status?: string; eventId?: string } = {}) {
  n++;
  raw["prepare"](
    `INSERT INTO inbound_emails (id, received_at, from_address, to_address, subject, intent, status,
       reply_kind, attachment_count, resulting_event_id, created_at)
     VALUES (?, ?, ?, 'photos@x.test', 's', 'photo_intake', ?, 'photo-intake-unresolved', 1, ?, ?)`
  ).run(
    `ie-${n}`,
    Math.floor(at.getTime() / 1000),
    from,
    extra.status ?? "replied",
    extra.eventId ?? null,
    Math.floor(at.getTime() / 1000)
  );
}
const yesterday = new Date(NOW.getTime() - 20 * 3600_000);

beforeEach(() => {
  ({ db, raw } = createTestDb());
});

describe("isOperatorAddress (OPE-1584)", () => {
  it("matches the operator, any case, with a plus-tag", () => {
    expect(isOperatorAddress(OPERATOR)).toBe(true);
    expect(isOperatorAddress(OPERATOR.toUpperCase())).toBe(true);
    expect(isOperatorAddress("admin+snap@takemetothefair.com")).toBe(true);
  });
  it("does not match anyone else", () => {
    expect(isOperatorAddress("user.alder@example.com")).toBe(false);
    expect(isOperatorAddress("admin@example.com")).toBe(false);
    expect(isOperatorAddress(null)).toBe(false);
  });
});

describe("held operator photos in the digest (OPE-1584)", () => {
  it("ten uploads in one day are one line and one email", async () => {
    for (let i = 0; i < 10; i++) held(OPERATOR, yesterday);
    const sent: Array<{ text: string }> = [];
    const env = {
      ALERT_EMAIL_TECHNICAL: "ops@example.com",
      EMAIL_JOBS: { send: async (m: { text: string }) => void sent.push(m) },
    } as unknown as Parameters<typeof checkOperatorQueues>[1];

    await checkOperatorQueues(db, env, NOW);

    expect(sent).toHaveLength(1);
    const matching = sent[0].text.split("\n").filter((l) => l.includes("of your photos"));
    expect(matching).toHaveLength(1);
    expect(matching[0]).toContain("10 of your photos from 2026-10-31");
    expect(matching[0]).toContain("/admin/inbound-emails");
  });

  it("leaves out external senders, resolved batches, disposed rows and old batches", async () => {
    held("user.alder@example.com", yesterday);
    held(OPERATOR, yesterday, { eventId: "ev-1" });
    held(OPERATOR, yesterday, { status: "rejected" });
    held(OPERATOR, new Date(NOW.getTime() - 40 * 86_400_000));
    held(OPERATOR, yesterday); // landmark: the one that counts
    held("admin+snap@takemetothefair.com", yesterday); // same mailbox, also silenced

    const q = await readOperatorQueues(db, NOW);

    expect(q.heldOperatorPhotos).toBe(2);
  });
});
