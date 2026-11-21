/**
 * OPE-1690 — our own 06:00Z crons overloaded D1 every morning: ~30 daily-batch
 * tasks, the every-10-minutes fan-out and the hourly fan-out all started in the same
 * second, and the full duplicate sweep was the largest of them.
 *
 * Pinned here:
 *  - staggerCronTasks starts tasks `spacing` apart, still awaits all of them,
 *    and still logs each rejection by name;
 *  - the daily batch is off the :00 minute and uses the stagger;
 *  - the full sweep has its own slot, registered in wrangler.toml, clear of
 *    the other 06:xx fires, and is not in the daily batch;
 *  - the sweep cron retries an overloaded type with backoff, and only that.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const logError = vi.fn(async (..._a: unknown[]) => {});
vi.mock("../src/logger.js", () => ({ logError: (...a: unknown[]) => logError(...a) }));

import { staggerCronTasks } from "../src/cron-tasks.js";
import {
  runScheduledFullDuplicateSweep,
  SWEEP_RETRY_DELAYS_MS,
} from "../src/full-duplicate-sweep-cron.js";
import type { Env } from "../src/index.js";

beforeEach(() => logError.mockClear());

describe("staggerCronTasks", () => {
  it("delays task i by i × spacing, awaits every task, and logs a rejection by name", async () => {
    const waits: number[] = [];
    const ran: string[] = [];
    const out = await staggerCronTasks(
      {} as D1Database,
      "5 6 * * *",
      [
        ["a", async () => void ran.push("a")],
        ["b", async () => Promise.reject(new Error("boom"))],
        ["c", async () => void ran.push("c")],
      ],
      3000,
      async (ms) => void waits.push(ms)
    );
    expect(waits).toEqual([3000, 6000]); // task 0 starts at once
    expect(ran.sort()).toEqual(["a", "c"]);
    expect(out).toEqual([
      { name: "a", ok: true },
      { name: "b", ok: false },
      { name: "c", ok: true },
    ]);
    expect(logError).toHaveBeenCalledTimes(1);
    expect((logError.mock.calls[0][1] as { source: string }).source).toBe("mcp:schedule:b");
  });
});

const dir = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(dir, "../src/index.ts"), "utf8");
const WRANGLER = readFileSync(path.join(dir, "../wrangler.toml"), "utf8");
const crons = (WRANGLER.match(/^crons = \[(.*)\]$/m)?.[1] ?? "")
  .split(",")
  .map((c) => c.trim().replace(/^"|"$/g, ""))
  .filter(Boolean);

describe("06:xx schedule (source-asserted)", () => {
  const batch = SRC.slice(SRC.indexOf("// Default daily branch"));
  const sweepStart = SRC.indexOf('if (controller.cron === "45 6 * * *") {');
  const sweepBranch = SRC.slice(sweepStart, SRC.indexOf("return;", sweepStart));

  it("finds its anchors (guards against them rotting)", () => {
    expect(crons.length).toBeGreaterThan(5);
    expect(sweepStart).toBeGreaterThan(-1);
    expect(batch).toContain("runScheduledGa4LivenessCheck(env)");
  });

  it("the daily batch no longer fires at 06:00, and it is staggered", () => {
    expect(crons).not.toContain("0 6 * * *");
    expect(crons).toContain("5 6 * * *");
    expect(batch).toMatch(/staggerCronTasks\(\s*env\.DB,\s*controller\.cron,\s*\[/);
    expect(batch).toMatch(/\],\s*DAILY_BATCH_SPACING_MS\s*\)/);
  });

  it("the full duplicate sweep runs alone at 06:45, not in the batch", () => {
    expect(crons).toContain("45 6 * * *");
    expect(sweepBranch).toContain("runScheduledFullDuplicateSweep(env)");
    expect(batch).not.toContain("runScheduledFullDuplicateSweep(env)");
  });

  it("no two 06:xx daily triggers share a minute with the */10 or hourly fires", () => {
    const sixes = crons.filter((c) => / 6 \* \* \*$/.test(c)).map((c) => Number(c.split(" ")[0]));
    expect(sixes.length).toBeGreaterThanOrEqual(4);
    // The 06:10 holdout sample predates this ticket and is light; it is the
    // one deliberate co-fire with */10.
    for (const m of sixes.filter((m) => m !== 10)) expect(m % 10).not.toBe(0);
    expect(new Set(sixes).size).toBe(sixes.length);
  });
});

describe("runScheduledFullDuplicateSweep — retry", () => {
  const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  function envWith(responses: Response[]) {
    const calls: string[] = [];
    const env = {
      DB: {} as D1Database,
      MAIN_APP_URL: "https://app.test",
      INTERNAL_API_KEY: "k",
      MAIN_APP: {
        fetch: async (req: Request) => {
          calls.push(((await req.json()) as { type: string }).type);
          return responses.shift() ?? respond(200, { success: true });
        },
      },
    } as unknown as Env;
    return { env, calls };
  }

  it("retries an overloaded type with backoff, then moves on", async () => {
    const { env, calls } = envWith([
      respond(503, { error: "Full duplicate sweep failed", retryable: true }),
      respond(200, { success: true }),
    ]);
    const slept: number[] = [];
    await runScheduledFullDuplicateSweep(env, { sleep: async (ms) => void slept.push(ms) });
    expect(calls).toEqual(["venues", "venues", "events", "vendors", "promoters"]);
    expect(slept).toEqual([SWEEP_RETRY_DELAYS_MS[0]]);
    expect(logError).not.toHaveBeenCalled();
  });

  it("logs once with the attempt count when every retry is overloaded", async () => {
    const { env, calls } = envWith([
      respond(503, { error: "x", retryable: true }),
      respond(503, { error: "x", retryable: true }),
      respond(503, { error: "x", retryable: true }),
    ]);
    const slept: number[] = [];
    await runScheduledFullDuplicateSweep(env, { sleep: async (ms) => void slept.push(ms) });
    expect(calls.filter((t) => t === "venues")).toHaveLength(3);
    expect(slept).toEqual(SWEEP_RETRY_DELAYS_MS);
    expect(logError).toHaveBeenCalledTimes(1);
    const ctx = (logError.mock.calls[0][1] as { context: { attempts: number; type: string } })
      .context;
    expect(ctx).toMatchObject({ type: "venues", attempts: 3 });
  });

  it("does not retry a failure load does not explain", async () => {
    const { env, calls } = envWith([respond(401, { error: "Unauthorized" })]);
    const slept: number[] = [];
    await runScheduledFullDuplicateSweep(env, { sleep: async (ms) => void slept.push(ms) });
    expect(calls).toEqual(["venues", "events", "vendors", "promoters"]);
    expect(slept).toEqual([]);
    expect(logError).toHaveBeenCalledTimes(1);
  });
});
