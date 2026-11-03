/**
 * OPE-366 — the E2 push over unterminated crossings.
 *
 * What must hold: a NEW dead-end pushes; the same backlog an hour later does
 * not; the first run reports the backlog once; a hold never pushes; a crossing
 * under the age threshold never pushes; and a notice that cannot be delivered
 * does not advance the high-water mark (so the dead-end is reported once it can
 * be). Every completed run stamps the heartbeat, notified or not.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import {
  agentHeartbeats,
  membraneCrossings,
  unterminatedCrossingNoticeState,
} from "../src/schema.js";

const logError = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("../src/logger.js", () => ({ logError: (...a: unknown[]) => logError(...a) }));

import {
  decideUnterminatedNotice,
  runUnterminatedCrossingNotice,
  UNTERMINATED_NOTICE_RUN_CODE,
} from "../src/inbound/unterminated-crossing-notice.js";

const T0 = new Date("2026-10-01T12:00:00Z");
const at = (base: Date, hoursAgo: number) => new Date(base.getTime() - hoursAgo * 3600 * 1000);

async function crossing(
  db: TestDb,
  id: string,
  createdAt: Date,
  opts: { type?: string; dest?: string | null; notes?: string } = {}
) {
  await db.insert(membraneCrossings).values({
    id,
    sourceRef: `inbound_email:${id}`,
    destinationRef: opts.dest ?? null,
    crossingType: opts.type ?? "email_to_ticket",
    actor: "system",
    notes: opts.notes ?? null,
    createdAt,
  });
}

function env(sent: unknown[], to = "john@pimboat.com") {
  return {
    DB: {} as D1Database,
    EMAIL_JOBS: { send: async (b: unknown) => void sent.push(b) },
    UNTERMINATED_CROSSING_ALERT_EMAIL: to,
  };
}

async function stamp(db: TestDb) {
  const rows = await db
    .select()
    .from(agentHeartbeats)
    .where(eq(agentHeartbeats.agentCode, UNTERMINATED_NOTICE_RUN_CODE));
  return rows[0] ?? null;
}

beforeEach(() => logError.mockClear());

describe("OPE-366 decideUnterminatedNotice (pure)", () => {
  const c = (id: string, d: Date) => ({
    id,
    crossingType: "email_to_ticket",
    sourceRef: id,
    notes: null,
    createdAt: d,
  });
  it("nothing unterminated → silent", () => {
    expect(decideUnterminatedNotice([], null).notify).toBe(false);
  });
  it("first run reports the whole backlog", () => {
    const d = decideUnterminatedNotice([c("b", at(T0, 10)), c("a", at(T0, 20))], null);
    expect(d).toMatchObject({ notify: true, landing: true });
    expect(d.fresh.map((x) => x.id)).toEqual(["b", "a"]);
  });
  it("only crossings newer than the high-water mark are fresh", () => {
    const d = decideUnterminatedNotice([c("b", at(T0, 10)), c("a", at(T0, 20))], at(T0, 15));
    expect(d).toMatchObject({ notify: true, landing: false });
    expect(d.fresh.map((x) => x.id)).toEqual(["b"]);
  });
  it("a backlog at or below the high-water mark is silent", () => {
    expect(decideUnterminatedNotice([c("b", at(T0, 10))], at(T0, 10)).notify).toBe(false);
  });
});

describe("OPE-366 runUnterminatedCrossingNotice (against the test schema)", () => {
  it("lands once, stays quiet on the same backlog, then pushes ONLY the new dead-end", async () => {
    const { db } = createTestDb();
    await crossing(db, "katie", at(T0, 48), { notes: "support-ack" });
    await crossing(db, "ok", at(T0, 30), { dest: "event:e1" }); // terminated
    await crossing(db, "hold", at(T0, 40), { type: "email_to_hold" }); // excluded
    await crossing(db, "young", at(T0, 2)); // under the 6h threshold

    const sent: { to: string; subject: string; text: string }[] = [];
    const r1 = await runUnterminatedCrossingNotice(env(sent), db, T0);
    expect(r1).toEqual({ notified: true, fresh: 1, total: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("john@pimboat.com");
    expect(sent[0].subject).toMatch(/first report/);
    expect(sent[0].text).toContain("inbound_email:katie");
    for (const absent of ["inbound_email:ok", "inbound_email:hold", "inbound_email:young"]) {
      expect(sent[0].text).not.toContain(absent);
    }

    // Same table an hour later: the backlog has not changed → no push.
    const T1 = new Date(T0.getTime() + 3600 * 1000);
    const r2 = await runUnterminatedCrossingNotice(env(sent), db, T1);
    expect(r2?.notified).toBe(false);
    expect(sent).toHaveLength(1);
    expect((await stamp(db))?.lastSeenAt.getTime()).toBe(Math.floor(T1.getTime() / 1000) * 1000);

    // Ageing: "young" was 2h old at T0. At T0+5h it is 7h old → a NEW dead-end.
    const T2 = new Date(T0.getTime() + 5 * 3600 * 1000);
    const r3 = await runUnterminatedCrossingNotice(env(sent), db, T2);
    expect(r3).toEqual({ notified: true, fresh: 1, total: 2 });
    expect(sent).toHaveLength(2);
    expect(sent[1].subject).not.toMatch(/first report/);
    expect(sent[1].text).toContain("inbound_email:young");
    expect(sent[1].text).not.toContain("inbound_email:katie");
  });

  it("no recipient: logs, does not advance the high-water mark, and still stamps the run", async () => {
    const { db } = createTestDb();
    await crossing(db, "katie", at(T0, 48));
    const sent: unknown[] = [];
    const r = await runUnterminatedCrossingNotice(env(sent, ""), db, T0);
    expect(r?.notified).toBe(false);
    expect(sent).toHaveLength(0);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(await db.select().from(unterminatedCrossingNoticeState)).toHaveLength(0);
    expect(await stamp(db)).not.toBeNull();

    // Once a recipient exists, the same dead-end is reported — it was not lost.
    const r2 = await runUnterminatedCrossingNotice(env(sent), db, T0);
    expect(r2?.notified).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("an empty ledger is silent but the run is still stamped", async () => {
    const { db } = createTestDb();
    const sent: unknown[] = [];
    expect(await runUnterminatedCrossingNotice(env(sent), db, T0)).toEqual({
      notified: false,
      fresh: 0,
      total: 0,
    });
    expect(sent).toHaveLength(0);
    expect(await stamp(db)).not.toBeNull();
  });
});
