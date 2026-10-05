/**
 * OPE-1239 — the CI-trigger watchdog on the MCP Worker cron.
 *
 * The one thing it must never do is alarm on an UNKNOWN: the GitHub API is
 * called unauthenticated from shared egress IPs and will sometimes be
 * throttled. And a stuck commit must email once, not every ten minutes.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import { adminActions, tunableThresholds } from "../src/schema.js";
import {
  CI_WATCHDOG_ALERT_ACTION,
  CI_WATCHDOG_BLIND_ALERT_ACTION,
  CI_WATCHDOG_RUN_ACTION,
  decideCiTrigger,
  runCiTriggerWatchdog,
} from "../src/ci-trigger-watchdog.js";

const NOW = new Date("2026-09-30T18:00:00Z");
const SHA = "bfd9dcddbec0cdc006f812fd957f937b81540d66";

describe("decideCiTrigger (pure)", () => {
  const at = (minAgo: number) => new Date(NOW.getTime() - minAgo * 60_000);
  it("a push run → ok", () =>
    expect(
      decideCiTrigger({ committedAt: at(500), pushRuns: 1, now: NOW, graceMinutes: 15 }).verdict
    ).toBe("ok"));
  it("no run, young commit → grace", () =>
    expect(
      decideCiTrigger({ committedAt: at(5), pushRuns: 0, now: NOW, graceMinutes: 15 }).verdict
    ).toBe("grace"));
  it("no run, old commit → missing", () =>
    expect(
      decideCiTrigger({ committedAt: at(40), pushRuns: 0, now: NOW, graceMinutes: 15 })
    ).toEqual({
      verdict: "missing",
      ageMinutes: 40,
    }));
  it("the API could not say → unknown, never missing", () => {
    expect(
      decideCiTrigger({ committedAt: at(40), pushRuns: null, now: NOW, graceMinutes: 15 }).verdict
    ).toBe("unknown");
    expect(
      decideCiTrigger({ committedAt: null, pushRuns: 0, now: NOW, graceMinutes: 15 }).verdict
    ).toBe("unknown");
  });
});

/** A fake GitHub API: HEAD `SHA`, committed `minAgo` ago, with `runs` push runs. */
function github(opts: { minAgo: number; runs: number; status?: number; runsStatus?: number }) {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    if (url.endsWith("/commits/main")) {
      if (opts.status && opts.status !== 200)
        return new Response("rate limited", { status: opts.status });
      return Response.json({
        sha: SHA,
        commit: {
          committer: { date: new Date(NOW.getTime() - opts.minAgo * 60_000).toISOString() },
        },
      });
    }
    if (url.includes("/actions/workflows/ci.yml/runs")) {
      if (opts.runsStatus && opts.runsStatus !== 200)
        return new Response("x", { status: opts.runsStatus });
      return Response.json({ total_count: opts.runs });
    }
    return new Response("nope", { status: 404 });
  };
  return { fetchImpl, calls };
}

let db: TestDb;
let sent: Array<{ to: string; subject: string }>;
const env = () => ({
  ALERT_EMAIL_TECHNICAL: "ops@example.com",
  EMAIL_JOBS: { send: async (m: { to: string; subject: string }) => void sent.push(m) } as never,
});
const rows = (action: string) =>
  db.select().from(adminActions).where(eq(adminActions.action, action)).all();

beforeEach(() => {
  ({ db } = createTestDb());
  sent = [];
});

describe("runCiTriggerWatchdog", () => {
  it("healthy HEAD: no alert, one heartbeat row, and the push-only query is what it asked", async () => {
    const gh = github({ minAgo: 300, runs: 1 });
    const r = await runCiTriggerWatchdog(db as never, env(), { fetchImpl: gh.fetchImpl, now: NOW });
    expect(r).toMatchObject({ verdict: "ok", alerted: false, sha: SHA });
    expect(sent).toHaveLength(0);
    expect(rows(CI_WATCHDOG_RUN_ACTION)).toHaveLength(1);
    expect(gh.calls[1]).toContain(`head_sha=${SHA}&event=push`);
  });

  it("missing push CI: emails on the SECOND sighting, once for the SHA, not again after", async () => {
    const gh = github({ minAgo: 40, runs: 0 });
    const at = (m: number) => ({
      fetchImpl: gh.fetchImpl,
      now: new Date(NOW.getTime() + m * 60_000),
    });
    const first = await runCiTriggerWatchdog(db as never, env(), at(0));
    const second = await runCiTriggerWatchdog(db as never, env(), at(10));
    const third = await runCiTriggerWatchdog(db as never, env(), at(20));
    expect(first).toMatchObject({ verdict: "missing", alerted: false });
    expect(second).toMatchObject({ verdict: "missing", alerted: true });
    expect(third).toMatchObject({ verdict: "missing", alerted: false });
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain(SHA.slice(0, 8));
    expect(rows(CI_WATCHDOG_ALERT_ACTION)).toHaveLength(1);
  });

  it("inside the grace period: no alert", async () => {
    const r = await runCiTriggerWatchdog(db as never, env(), {
      fetchImpl: github({ minAgo: 5, runs: 0 }).fetchImpl,
      now: NOW,
    });
    expect(r).toMatchObject({ verdict: "grace", alerted: false });
    expect(sent).toHaveLength(0);
  });

  it.each([
    ["commits endpoint throttled", { minAgo: 400, runs: 0, status: 403 }],
    ["runs endpoint throttled", { minAgo: 400, runs: 0, runsStatus: 429 }],
  ])("%s → unknown, no alert, still stamps a heartbeat", async (_l, opts) => {
    const r = await runCiTriggerWatchdog(db as never, env(), {
      fetchImpl: github(opts).fetchImpl,
      now: NOW,
    });
    expect(r.verdict).toBe("unknown");
    expect(sent).toHaveLength(0);
    expect(rows(CI_WATCHDOG_RUN_ACTION)).toHaveLength(1);
  });

  it("a network failure is unknown, not a crash", async () => {
    const r = await runCiTriggerWatchdog(db as never, env(), {
      fetchImpl: async () => {
        throw new Error("dns");
      },
      now: NOW,
    });
    expect(r.verdict).toBe("unknown");
    expect(sent).toHaveLength(0);
  });

  it("grace comes from tunable_thresholds", async () => {
    db.insert(tunableThresholds)
      .values({
        key: "ci_trigger_watchdog_grace_minutes",
        value: 60,
        unit: "minutes",
        updatedAt: NOW,
      } as never)
      .run();
    const r = await runCiTriggerWatchdog(db as never, env(), {
      fetchImpl: github({ minAgo: 40, runs: 0 }).fetchImpl,
      now: NOW,
    });
    expect(r.verdict).toBe("grace");
  });

  it("the heartbeat is stamped at most hourly, not every ten minutes", async () => {
    const gh = github({ minAgo: 300, runs: 1 });
    for (let i = 0; i < 6; i++) {
      await runCiTriggerWatchdog(db as never, env(), {
        fetchImpl: gh.fetchImpl,
        now: new Date(NOW.getTime() + i * 10 * 60_000),
      });
    }
    expect(rows(CI_WATCHDOG_RUN_ACTION)).toHaveLength(1);
    await runCiTriggerWatchdog(db as never, env(), {
      fetchImpl: gh.fetchImpl,
      now: new Date(NOW.getTime() + 61 * 60_000),
    });
    expect(rows(CI_WATCHDOG_RUN_ACTION)).toHaveLength(2);
  });
});

/**
 * OPE-1239 rework — the two false "not deployed" emails of 10-01 and 10-02.
 * Each SHA read `ok` for hours, then one runs lookup answered 200 with
 * total_count 0. Replayed here tick by tick.
 */
describe("OPE-1239 rework — no alarm on a SHA already seen ok; confirm before alerting; say when blind", () => {
  const tick = (m: number, gh: ReturnType<typeof github>) =>
    runCiTriggerWatchdog(db as never, env(), {
      fetchImpl: gh.fetchImpl,
      now: new Date(NOW.getTime() + m * 60_000),
    });

  it("bcc76d0c replay: ok for hours, then repeated 200/total_count:0 → unknown, NO email", async () => {
    const ok = github({ minAgo: 300, runs: 1 });
    const empty = github({ minAgo: 300, runs: 0 });
    for (const m of [0, 60, 130, 250]) expect((await tick(m, ok)).verdict).toBe("ok");
    for (const m of [310, 320, 330]) {
      const r = await tick(m, empty);
      expect(r.verdict).toBe("unknown");
      expect(r.note).toContain("already seen ok");
    }
    expect(sent).toHaveLength(0);
    expect(rows(CI_WATCHDOG_ALERT_ACTION)).toHaveLength(0);
  });

  it("one missing sighting alone never emails", async () => {
    await tick(0, github({ minAgo: 40, runs: 0 }));
    await tick(10, github({ minAgo: 50, runs: 1 })); // the next look finds the run
    expect(sent).toHaveLength(0);
  });

  it("a second sighting too soon (< 9 min) does not confirm", async () => {
    const gh = github({ minAgo: 40, runs: 0 });
    await tick(0, gh);
    const r = await tick(5, gh);
    expect(r.alerted).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("blind for 6h after a real answer → ONE blind email, not one per tick", async () => {
    await tick(0, github({ minAgo: 300, runs: 1 })); // a real answer
    const throttled = github({ minAgo: 400, runs: 0, status: 403 });
    for (let m = 10; m < 360; m += 10) await tick(m, throttled);
    expect(sent).toHaveLength(0); // under 6h: silent
    await tick(360, throttled);
    await tick(370, throttled);
    await tick(480, throttled);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain("blind");
    expect(rows(CI_WATCHDOG_BLIND_ALERT_ACTION)).toHaveLength(1);
  });

  it("a fresh deploy that has never had a real answer does not call itself blind", async () => {
    const throttled = github({ minAgo: 400, runs: 0, status: 403 });
    for (let m = 0; m <= 420; m += 60) await tick(m, throttled);
    expect(sent).toHaveLength(0);
  });

  it("any real answer resets the blind clock", async () => {
    await tick(0, github({ minAgo: 300, runs: 1 }));
    const throttled = github({ minAgo: 400, runs: 0, status: 403 });
    for (let m = 10; m < 300; m += 10) await tick(m, throttled);
    await tick(300, github({ minAgo: 600, runs: 1 })); // real answer at 5h
    for (let m = 310; m < 600; m += 10) await tick(m, throttled); // 4h50m blind
    expect(sent).toHaveLength(0);
  });
});
