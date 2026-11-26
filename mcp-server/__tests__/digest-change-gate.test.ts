/**
 * OPE-1585 — the rule itself, then the Done-when: on a day with no new items,
 * the digest does not send, and Monday still lists the standing items.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { createTestDb } from "./setup-db.js";
import {
  clearDigestState,
  digestChanged,
  driftTolerance,
  recordDigestSent,
  shouldSendDigest,
} from "../src/digest-change-gate.js";
import { checkOperatorQueues } from "../src/operator-queue-notice.js";
import { readStandingItemsSection } from "../src/weekly-inventory-notice.js";

const snap = (counts: Record<string, number>, severity = 0) => ({ counts, severity });

describe("digestChanged (OPE-1585)", () => {
  it("sends the first time", () => {
    expect(digestChanged(snap({ q: 5 }), null)).toBe(true);
  });

  it("stays quiet when nothing moved", () => {
    expect(digestChanged(snap({ q: 5 }), snap({ q: 5 }))).toBe(false);
  });

  it("treats +1 and -1 on an unchanged queue as drift", () => {
    expect(digestChanged(snap({ q: 6 }), snap({ q: 5 }))).toBe(false);
    expect(digestChanged(snap({ q: 4 }), snap({ q: 5 }))).toBe(false);
  });

  it("sends once movement exceeds drift", () => {
    expect(digestChanged(snap({ q: 7 }), snap({ q: 5 }))).toBe(true);
  });

  it("scales drift with queue size, with a floor of 1", () => {
    expect(driftTolerance(5)).toBe(1);
    expect(driftTolerance(34)).toBe(3);
    expect(digestChanged(snap({ q: 37 }), snap({ q: 34 }))).toBe(false);
    expect(digestChanged(snap({ q: 38 }), snap({ q: 34 }))).toBe(true);
  });

  it("adds movement across queues", () => {
    expect(digestChanged(snap({ a: 2, b: 2 }), snap({ a: 1, b: 1 }))).toBe(true);
  });

  it("a queue going from empty to one item is news at any size", () => {
    expect(digestChanged(snap({ big: 100, claims: 1 }), snap({ big: 100, claims: 0 }))).toBe(true);
  });

  it("a rise in severity sends even with flat counts", () => {
    expect(digestChanged(snap({ q: 5 }, 2), snap({ q: 5 }, 1))).toBe(true);
    expect(digestChanged(snap({ q: 5 }, 1), snap({ q: 5 }, 2))).toBe(false);
  });

  it("creep is measured from the last SEND, so it eventually reports", () => {
    const lastSent = snap({ q: 34 });
    const days = [35, 36, 37, 38].map((n) => digestChanged(snap({ q: n }), lastSent));
    expect(days).toEqual([false, false, false, true]);
  });
});

describe("digest state (OPE-1585)", () => {
  const SRC = "test";
  const NOW = new Date("2026-11-08T06:00:00Z");
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("sends with no row, stays quiet after recording, sends again after clearing", async () => {
    const s = snap({ q: 5 });
    expect(await shouldSendDigest(db, "k", s, SRC)).toBe(true);
    await recordDigestSent(db, "k", s, NOW, SRC);
    expect(await shouldSendDigest(db, "k", s, SRC)).toBe(false);
    await clearDigestState(db, "k", SRC);
    expect(await shouldSendDigest(db, "k", s, SRC)).toBe(true);
  });

  it("recording twice replaces the row", async () => {
    await recordDigestSent(db, "k", snap({ q: 5 }), NOW, SRC);
    await recordDigestSent(db, "k", snap({ q: 50 }), NOW, SRC);
    expect(await shouldSendDigest(db, "k", snap({ q: 50 }), SRC)).toBe(false);
  });

  it("fails OPEN when the state read throws", async () => {
    const broken = {
      select: () => {
        throw new Error("D1 down");
      },
      insert: () => ({ values: () => ({ run: () => {} }) }),
    } as unknown as typeof db;
    await expect(shouldSendDigest(broken, "k", snap({ q: 5 }), SRC)).resolves.toBe(true);
  });
});

describe("operator-queue digest, end to end (OPE-1585 Done-when)", () => {
  const DAY = 86_400_000;
  const NOW = new Date("2026-11-08T06:00:00Z");
  type Mail = { subject: string };
  let raw: ReturnType<typeof createTestDb>["raw"];
  let db: ReturnType<typeof createTestDb>["db"];
  let sent: Mail[];
  let env: Parameters<typeof checkOperatorQueues>[1];

  function seedClaim(id: string, ageDays: number) {
    raw["prepare"](
      `INSERT INTO entity_claims (id, entity_type, entity_id, user_id, method, status, created_at)
       VALUES (?, 'VENDOR', ?, 'u-1', 'email_domain', 'PENDING', ?)`
    ).run(id, `v-${id}`, Math.floor((NOW.getTime() - ageDays * DAY) / 1000));
  }

  beforeEach(() => {
    ({ db, raw } = createTestDb());
    raw["prepare"](
      `INSERT INTO users (id, email, name, role) VALUES ('u-1','a@example.com','A','VENDOR')`
    ).run();
    sent = [];
    env = {
      ALERT_EMAIL_TECHNICAL: "ops@example.com",
      EMAIL_JOBS: {
        send: async (m: Mail) => {
          sent.push(m);
        },
      },
    } as unknown as Parameters<typeof checkOperatorQueues>[1];
    seedClaim("c1", 8);
    seedClaim("c2", 8);
  });

  it("sends once, then not on a day with no new items", async () => {
    await checkOperatorQueues(db, env, NOW);
    expect(sent).toHaveLength(1);

    await checkOperatorQueues(db, env, new Date(NOW.getTime() + DAY));
    expect(sent).toHaveLength(1);
  });

  it("sends again when the queue has really moved", async () => {
    await checkOperatorQueues(db, env, NOW);

    seedClaim("c3", 8);
    seedClaim("c4", 8);
    await checkOperatorQueues(db, env, new Date(NOW.getTime() + DAY));
    expect(sent).toHaveLength(2);
  });

  it("Monday's inventory still lists the standing items the digest went quiet on", async () => {
    await checkOperatorQueues(db, env, NOW);
    await checkOperatorQueues(db, env, new Date(NOW.getTime() + DAY));
    expect(sent).toHaveLength(1);

    const section = await readStandingItemsSection(db, env, new Date(NOW.getTime() + DAY));
    expect(section).toContain("Operator queues: 2 waiting");
    expect(section).toContain("Inbound-email triage:");
    expect(section).toContain("Dedup clusters:");
  });
});
