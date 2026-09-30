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

  it("missing push CI: emails ONCE for the SHA, not again on the next run", async () => {
    const gh = github({ minAgo: 40, runs: 0 });
    const first = await runCiTriggerWatchdog(db as never, env(), {
      fetchImpl: gh.fetchImpl,
      now: NOW,
    });
    const second = await runCiTriggerWatchdog(db as never, env(), {
      fetchImpl: gh.fetchImpl,
      now: new Date(NOW.getTime() + 10 * 60_000),
    });
    expect(first).toMatchObject({ verdict: "missing", alerted: true });
    expect(second).toMatchObject({ verdict: "missing", alerted: false });
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
