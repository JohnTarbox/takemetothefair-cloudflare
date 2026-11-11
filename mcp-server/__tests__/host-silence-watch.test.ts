import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  decideHostState,
  parseStampNote,
  transitionToMail,
  runHostSilenceWatch,
  recordHostHeartbeat,
  HOST_SILENCE_THRESHOLD_MS,
  HOST_WATCH_CODE,
  hostCode,
} from "../src/host-silence-watch.js";
import { createTestDb } from "./setup-db.js";
import { agentHeartbeats } from "../src/schema.js";

const harness = vi.hoisted(() => ({ db: null as any }));
vi.mock("../src/db.js", () => ({ getDb: () => harness.db }));

const at = (iso: string) => new Date(iso);
const minsAfter = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);

describe("decideHostState (OPE-1637)", () => {
  const now = at("2026-11-11T23:00:00Z");
  it("is dormant with no host stamp, so deploy day never pages", () => {
    expect(decideHostState(null, now).state).toBe("dormant");
  });
  it("is ok just under 75 min and silent just over", () => {
    const under = new Date(now.getTime() - HOST_SILENCE_THRESHOLD_MS + 60_000);
    const over = new Date(now.getTime() - HOST_SILENCE_THRESHOLD_MS - 60_000);
    expect(decideHostState(under, now).state).toBe("ok");
    expect(decideHostState(over, now)).toEqual({ state: "silent", staleMinutes: 76 });
  });
});

describe("transitionToMail", () => {
  it("mails exactly on entering silent and on leaving it", () => {
    expect(transitionToMail("ok", "silent")).toBe("silent");
    expect(transitionToMail(undefined, "silent")).toBe("silent");
    expect(transitionToMail("dormant", "silent")).toBe("silent");
    expect(transitionToMail("silent", "silent")).toBeNull();
    expect(transitionToMail("silent", "ok")).toBe("cleared");
    expect(transitionToMail("ok", "ok")).toBeNull();
    expect(transitionToMail("dormant", "ok")).toBeNull();
    expect(transitionToMail(undefined, "ok")).toBeNull();
  });
  it("parses only well-formed note parts", () => {
    const m = parseStampNote("developer-claude-code=silent;junk;x=bogus");
    expect([...m.entries()]).toEqual([["developer-claude-code", "silent"]]);
    expect(parseStampNote(null).size).toBe(0);
  });
});

describe("runHostSilenceWatch end to end", () => {
  let db: any;
  let sent: any[];
  let env: any;
  const lastFire = at("2026-11-11T05:30:00Z");

  beforeEach(() => {
    ({ db: harness.db } = createTestDb());
    db = harness.db;
    sent = [];
    env = {
      DB: {} as any,
      EMAIL_JOBS: { send: async (m: any) => void sent.push(m) },
      ALERT_EMAIL_TECHNICAL: "alert@example.com",
    };
  });

  const stampRow = async () =>
    (
      await db.select().from(agentHeartbeats).where(eq(agentHeartbeats.agentCode, HOST_WATCH_CODE))
    )[0];

  it("replays an outage: one mail when it goes silent, none while it stays down, one when it clears", async () => {
    await recordHostHeartbeat({} as any, "developer-claude-code", null, lastFire);

    // 06:00 — 30 min since the last fire: ok, nothing sent.
    let r = await runHostSilenceWatch(env, { now: minsAfter(lastFire, 30) });
    expect(r.verdicts[0].state).toBe("ok");
    expect(sent).toHaveLength(0);

    // 07:00 — 90 min: silent → ONE mail.
    r = await runHostSilenceWatch(env, { now: minsAfter(lastFire, 90) });
    expect(r.verdicts[0].state).toBe("silent");
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain("developer-claude-code host silent 90 min");
    expect(sent[0].to).toBe("alert@example.com");

    // 08:00 and 09:00 — still down: no repeat mail.
    await runHostSilenceWatch(env, { now: minsAfter(lastFire, 150) });
    await runHostSilenceWatch(env, { now: minsAfter(lastFire, 210) });
    expect(sent).toHaveLength(1);
    expect((await stampRow()).note).toBe("developer-claude-code=silent");

    // Cron comes back: a fresh stamp, then the next hourly check → ONE "back" mail.
    await recordHostHeartbeat({} as any, "developer-claude-code", null, minsAfter(lastFire, 240));
    r = await runHostSilenceWatch(env, { now: minsAfter(lastFire, 250) });
    expect(r.verdicts[0].state).toBe("ok");
    expect(sent).toHaveLength(2);
    expect(sent[1].subject).toContain("host is back");
  });

  it("stays dormant (and says so in its stamp) until the first host stamp exists", async () => {
    const r = await runHostSilenceWatch(env, { now: lastFire });
    expect(r.verdicts[0].state).toBe("dormant");
    expect(sent).toHaveLength(0);
    expect((await stampRow()).note).toBe("developer-claude-code=dormant");
    expect((await stampRow()).kind).toBe("watchdog");
  });

  it("retries a mail whose send failed instead of recording it as sent", async () => {
    await recordHostHeartbeat({} as any, "developer-claude-code", null, lastFire);
    await runHostSilenceWatch(env, { now: minsAfter(lastFire, 30) }); // ok
    env.EMAIL_JOBS.send = async () => {
      throw new Error("queue down");
    };
    await runHostSilenceWatch(env, { now: minsAfter(lastFire, 90) });
    expect((await stampRow()).note).toBe("developer-claude-code=ok");
    env.EMAIL_JOBS.send = async (m: any) => void sent.push(m);
    await runHostSilenceWatch(env, { now: minsAfter(lastFire, 150) });
    expect(sent).toHaveLength(1);
  });

  it("writes host stamps as kind='host', never 'agent', so the daily watchdog can't be kept quiet by them", async () => {
    await recordHostHeartbeat({} as any, "developer-claude-code", "fire", lastFire);
    const [row] = await db
      .select()
      .from(agentHeartbeats)
      .where(eq(agentHeartbeats.agentCode, hostCode("developer-claude-code")));
    expect(row.kind).toBe("host");
    const agentRows = await db
      .select()
      .from(agentHeartbeats)
      .where(eq(agentHeartbeats.kind, "agent"));
    expect(agentRows).toHaveLength(0);
  });
});
