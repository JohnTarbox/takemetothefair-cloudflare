/**
 * OPE-907 — the `BurstCounter` Durable Object (src/burst-counter.ts, OPE-951)
 * running in workerd.
 *
 * `__tests__/burst-counter-ope951.test.ts` drives the class with a hand-written
 * `ctx.storage` fake. The properties OPE-951 depends on are the runtime's, not
 * the class's, so a fake cannot demonstrate them:
 *   - `ctx.storage.kv` is the SYNCHRONOUS KV API of a SQLite-backed object — it
 *     only exists when the class is bound with SQLite storage;
 *   - concurrent RPC calls to one instance cannot interleave between the read
 *     and the write, so N parallel hits against limit L succeed exactly L times;
 *   - `setAlarm` schedules a real alarm whose handler clears the storage;
 *   - the result crosses the RPC boundary intact.
 */
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { BurstCounter, BurstWindowState } from "../src/burst-counter.js";
import type { WorkerdTestEnv } from "./env.js";

const { BURST_COUNTER } = env as unknown as WorkerdTestEnv;

function counterFor(key: string) {
  return BURST_COUNTER.get(BURST_COUNTER.idFromName(key));
}

describe("OPE-907 workerd — BurstCounter Durable Object", () => {
  it("hits 1..limit succeed over RPC, the next is refused with a Retry-After inside the window", async () => {
    const stub = counterFor("register:203.0.113.7");

    const results = [];
    for (let i = 0; i < 4; i++) results.push(await stub.hit(3, 60));

    expect(results.map((r) => r.success)).toEqual([true, true, true, false]);
    expect(results.map((r) => r.count)).toEqual([1, 2, 3, 4]);
    expect(results[3].retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(results[3].retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("parallel hits on one key cannot interleave: 20 concurrent against limit 5 succeed exactly 5 times", async () => {
    const stub = counterFor("suggest-event:198.51.100.9");

    const results = await Promise.all(Array.from({ length: 20 }, () => stub.hit(5, 60)));

    expect(results.filter((r) => r.success)).toHaveLength(5);
    // Every hit was counted — the clamp holds at limit + 1, never a lost update.
    expect(Math.max(...results.map((r) => r.count))).toBe(6);
  });

  it("keys are isolated: a refused key does not spend another key's budget", async () => {
    const a = counterFor("newsletter:192.0.2.1");
    const b = counterFor("newsletter:192.0.2.2");

    await a.hit(1, 60);
    expect((await a.hit(1, 60)).success).toBe(false);
    expect((await b.hit(1, 60)).success).toBe(true);
  });

  it("state lives in the SQLite-backed synchronous KV, and the alarm at window end clears it", async () => {
    const stub = counterFor("forgot-password:203.0.113.50");
    await stub.hit(2, 60);
    await stub.hit(2, 60);

    const stored = await runInDurableObject(
      stub,
      async (_instance: BurstCounter, state: DurableObjectState) => ({
        window: state.storage.kv.get<BurstWindowState>("w"),
        alarm: await state.storage.getAlarm(),
      })
    );
    expect(stored.window?.count).toBe(2);
    expect(stored.alarm).toBe((stored.window?.windowStart ?? 0) + 60_000);

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const afterAlarm = await runInDurableObject(
      stub,
      (_instance: BurstCounter, state: DurableObjectState) =>
        state.storage.kv.get<BurstWindowState>("w")
    );
    expect(afterAlarm).toBeUndefined();
    // A fresh window: the budget is back.
    expect(await stub.hit(2, 60)).toMatchObject({ success: true, count: 1 });
  });

  it("an invalid limit rejects across the RPC boundary instead of disabling the cap", async () => {
    const stub = counterFor("verify-email:192.0.2.77");
    let thrown: unknown;
    try {
      await stub.hit(0, 60);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/limit must be an integer/);
  });
});
