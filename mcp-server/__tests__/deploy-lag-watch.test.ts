/**
 * OPE-1655 — the hourly deploy-lag watch.
 *
 * The end-to-end case replays the real freeze: prod on 00f6c96 (deployed
 * 11-13), #1800 merged 2026-11-16T00:36:37Z and #1790 at 02:51Z, neither
 * deployed. The ticket's bar is "would have fired by 11-15 ~23:51 ET at the
 * latest" (= 11-16 04:51Z); measured from the OLDEST undeployed merge it fires
 * on the 03:00Z tick.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  decideLag,
  overallState,
  transitionToMail,
  parseStampState,
  runDeployLagWatch,
  DEPLOY_LAG_THRESHOLD_MS,
  DEPLOY_LAG_WATCH_CODE,
  DEPLOY_LAG_SOURCE,
  DEPLOY_LAG_FAULT_MESSAGE,
  type WorkerLag,
} from "../src/deploy-lag-watch.js";
import { createTestDb } from "./setup-db.js";
import { agentHeartbeats, errorLogs } from "../src/schema.js";

const harness = vi.hoisted(() => ({ db: null as any }));
vi.mock("../src/db.js", () => ({ getDb: () => harness.db }));

const at = (iso: string) => new Date(iso);
const MAIN = "72523dc7" + "a".repeat(32);
const LIVE_OLD = "00f6c96";
const OLDEST_UNDEPLOYED = "2026-11-16T00:36:37Z";

describe("decideLag (pure)", () => {
  const now = at("2026-11-16T03:00:00Z");
  it("unknown when GitHub could not say; ok when live is main", () => {
    expect(decideLag({ behindBy: null, oldestUndeployedAt: null, now }).state).toBe("unknown");
    expect(decideLag({ behindBy: 0, oldestUndeployedAt: null, now })).toEqual({
      state: "ok",
      lagMinutes: 0,
    });
    expect(decideLag({ behindBy: 2, oldestUndeployedAt: null, now }).state).toBe("unknown");
  });
  it("is ok just under 2h and lagging just over", () => {
    const under = new Date(now.getTime() - DEPLOY_LAG_THRESHOLD_MS + 60_000);
    const over = new Date(now.getTime() - DEPLOY_LAG_THRESHOLD_MS - 60_000);
    expect(decideLag({ behindBy: 1, oldestUndeployedAt: under, now }).state).toBe("ok");
    expect(decideLag({ behindBy: 1, oldestUndeployedAt: over, now })).toEqual({
      state: "lagging",
      lagMinutes: 121,
    });
  });
  it("overall: any lagging wins; all-unknown is unknown", () => {
    const w = (state: WorkerLag["state"]) => ({ state }) as WorkerLag;
    expect(overallState([w("ok"), w("lagging")])).toBe("lagging");
    expect(overallState([w("ok"), w("unknown")])).toBe("ok");
    expect(overallState([w("unknown"), w("unknown")])).toBe("unknown");
  });
  it("mails only on entering lagging and on clearing; unknown never mails", () => {
    expect(transitionToMail(undefined, "lagging")).toBe("lagging");
    expect(transitionToMail("ok", "lagging")).toBe("lagging");
    expect(transitionToMail("lagging", "lagging")).toBeNull();
    expect(transitionToMail("lagging", "ok")).toBe("cleared");
    expect(transitionToMail("lagging", "unknown")).toBeNull();
    expect(transitionToMail(undefined, "ok")).toBeNull();
  });
  it("parses the state out of the stamp note only when well-formed", () => {
    expect(parseStampState("state=lagging;mcp=00f6c96;app=?;main=72523dc;lag=144")).toBe("lagging");
    expect(parseStampState("state=bogus;x")).toBeUndefined();
    expect(parseStampState(null)).toBeUndefined();
  });
});

describe("runDeployLagWatch end to end — the 11-13 → 11-16 freeze", () => {
  let db: any;
  let raw: any;
  let sent: any[];
  let env: any;
  let gh: { down: boolean; appSha: string | null; mainSha: string };
  const calls: string[] = [];

  const fetchImpl = async (url: string): Promise<Response> => {
    calls.push(url);
    const json = (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    if (url === "https://meetmeatthefair.com/api/health") {
      return json({ status: "healthy", gitSha: gh.appSha ?? "unknown" });
    }
    if (gh.down) return json({ message: "API rate limit exceeded" }, 403);
    if (url.endsWith("/commits/main")) return json({ sha: gh.mainSha });
    const cmp = /\/compare\/([0-9a-f]+)\.\.\.main$/.exec(url);
    if (cmp) {
      if (gh.mainSha.startsWith(cmp[1]))
        return json({ status: "identical", ahead_by: 0, commits: [] });
      return json({
        status: "ahead",
        ahead_by: 2,
        commits: [
          { commit: { committer: { date: OLDEST_UNDEPLOYED } } },
          { commit: { committer: { date: "2026-11-16T02:51:00Z" } } },
        ],
      });
    }
    if (url.includes("/contents/drizzle?ref=main")) {
      return json([
        { name: "0417_ope1637_host_silence_watch.sql", type: "file" },
        { name: "0421_ope1655_deploy_lag_watch.sql", type: "file" },
        { name: "meta", type: "dir" },
      ]);
    }
    return json({}, 404);
  };

  beforeEach(() => {
    ({ db: harness.db, raw } = createTestDb());
    db = harness.db;
    raw["exec"](
      "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)"
    );
    raw
      .prepare("INSERT INTO d1_migrations (name) VALUES (?)")
      .run("0417_ope1637_host_silence_watch.sql");
    sent = [];
    calls.length = 0;
    gh = { down: false, appSha: LIVE_OLD, mainSha: MAIN };
    env = {
      DB: {} as any,
      GIT_SHA: LIVE_OLD,
      EMAIL_JOBS: { send: async (m: any) => void sent.push(m) },
      ALERT_EMAIL_TECHNICAL: "alert@example.com",
    };
  });

  const stamp = async () =>
    (
      await db
        .select()
        .from(agentHeartbeats)
        .where(eq(agentHeartbeats.agentCode, DEPLOY_LAG_WATCH_CODE))
    )[0];
  const faultRows = async () =>
    db.select().from(errorLogs).where(eq(errorLogs.source, DEPLOY_LAG_SOURCE));

  it("one mail when lag crosses 2h, none while it lasts or while GitHub is blind, one when it clears", async () => {
    // 01:00Z — oldest undeployed merge is 24 min old: ok, no mail, no fault.
    let r = await runDeployLagWatch(env, { now: at("2026-11-16T01:00:00Z"), fetchImpl });
    expect(r.state).toBe("ok");
    expect(sent).toHaveLength(0);
    expect(await faultRows()).toHaveLength(0);
    expect((await stamp()).note).toMatch(/^state=ok;mcp=00f6c96;app=00f6c96;main=72523dc;/);

    // 03:00Z — 144 min: lagging → ONE mail naming both live SHAs, main, the pending migration.
    r = await runDeployLagWatch(env, { now: at("2026-11-16T03:00:00Z"), fetchImpl });
    expect(r.state).toBe("lagging");
    expect(r.workers.map((w) => [w.worker, w.state, w.behindBy, w.lagMinutes])).toEqual([
      ["mcp", "lagging", 2, 143],
      ["app", "lagging", 2, 143],
    ]);
    expect(r.pendingMigrations).toEqual(["0421_ope1655_deploy_lag_watch.sql"]);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("alert@example.com");
    expect(sent[0].subject).toBe("🚨 Production is 143 min behind main (deploys not landing)");
    expect(sent[0].text).toContain(`main HEAD: ${MAIN}`);
    expect(sent[0].text).toContain("MCP Worker: live 00f6c96, 2 commit(s) behind");
    expect(sent[0].text).toContain("main app: live 00f6c96, 2 commit(s) behind");
    expect(sent[0].text).toContain(
      "Pending migrations (merged, not applied to prod D1): 0421_ope1655_deploy_lag_watch.sql"
    );
    // The CPI fault row — stable message, so it groups into one signature.
    const f1 = await faultRows();
    expect(f1).toHaveLength(1);
    expect(f1[0].message).toBe(DEPLOY_LAG_FAULT_MESSAGE);
    expect(f1[0].level).toBe("error");

    // 04:00Z — still behind: no repeat mail, one more fault row (the recurrence).
    r = await runDeployLagWatch(env, { now: at("2026-11-16T04:00:00Z"), fetchImpl });
    expect(r.state).toBe("lagging");
    expect(sent).toHaveLength(1);
    expect(await faultRows()).toHaveLength(2);

    // 05:00Z — GitHub throttled: unknown. Neither raises nor clears; state held.
    gh.down = true;
    r = await runDeployLagWatch(env, { now: at("2026-11-16T05:00:00Z"), fetchImpl });
    expect(r.state).toBe("unknown");
    expect(sent).toHaveLength(1);
    expect((await stamp()).note).toMatch(/^state=lagging;/);

    // 15:00Z — #1805 merged and deployed: both Workers on main → ONE "cleared" mail.
    gh.down = false;
    env.GIT_SHA = MAIN.slice(0, 7);
    gh.appSha = MAIN.slice(0, 7);
    r = await runDeployLagWatch(env, { now: at("2026-11-16T15:00:00Z"), fetchImpl });
    expect(r.state).toBe("ok");
    expect(sent).toHaveLength(2);
    expect(sent[1].subject).toBe("✅ Production caught up with main");
    expect((await stamp()).note).toMatch(/^state=ok;/);
    // Positive landmark: no compare call is needed when live = main.
    expect(
      calls.filter((u) => u.includes("/compare/") && u.includes(MAIN.slice(0, 7)))
    ).toHaveLength(0);
  });

  it("before the app reports a SHA, judges the MCP Worker alone and says why", async () => {
    gh.appSha = null;
    const r = await runDeployLagWatch(env, { now: at("2026-11-16T03:00:00Z"), fetchImpl });
    expect(r.workers[1]).toMatchObject({ worker: "app", state: "unknown" });
    expect(r.workers[1].note).toContain('app gitSha "unknown"');
    expect(r.state).toBe("lagging");
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("main app: live unknown");
  });

  it("with no alert address, logs the would-be mail and retries it next run (state not advanced)", async () => {
    env.ALERT_EMAIL_TECHNICAL = undefined;
    await runDeployLagWatch(env, { now: at("2026-11-16T03:00:00Z"), fetchImpl });
    expect(sent).toHaveLength(0);
    expect((await stamp()).note).toMatch(/^state=unknown;/);
    env.ALERT_EMAIL_TECHNICAL = "alert@example.com";
    await runDeployLagWatch(env, { now: at("2026-11-16T04:00:00Z"), fetchImpl });
    expect(sent).toHaveLength(1);
  });

  it("stamps on every run, even when every read failed (the probe's evidence)", async () => {
    gh.down = true;
    gh.appSha = null;
    env.GIT_SHA = undefined;
    const r = await runDeployLagWatch(env, { now: at("2026-11-16T03:00:00Z"), fetchImpl });
    expect(r.state).toBe("unknown");
    const s = await stamp();
    expect(s.kind).toBe("watchdog");
    expect(s.lastSeenAt.toISOString()).toBe("2026-11-16T03:00:00.000Z");
  });
});
