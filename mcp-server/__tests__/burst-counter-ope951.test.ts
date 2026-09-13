/**
 * OPE-951 — the Durable Object burst counter that replaces the Workers Rate
 * Limiting binding as the hard cap.
 *
 * What these can and cannot prove: they pin the DECISION (window, count,
 * refusal, Retry-After) and the class's storage discipline against a fake
 * synchronous storage. They cannot prove Durable Object single-threading —
 * that is the runtime's guarantee, and the reason the design reads and writes
 * with no await between. Production proof is the acceptance probe on the
 * ticket, run after the main-app binding deploys.
 */
import { describe, expect, it } from "vitest";
import {
  BurstCounter,
  decideBurstHit,
  validateBurstArgs,
  type BurstWindowState,
} from "../src/burst-counter.js";

describe("OPE-951 — decideBurstHit", () => {
  const T0 = 1_800_000_000_000;

  it("allows exactly `limit` hits in a window, then refuses", () => {
    let state: BurstWindowState | null = null;
    const seen: boolean[] = [];
    for (let i = 0; i < 8; i++) {
      const { next, result } = decideBurstHit(state, T0 + i * 100, 5, 60);
      state = next;
      seen.push(result.success);
    }
    expect(seen).toEqual([true, true, true, true, true, false, false, false]);
  });

  it("Retry-After counts down to the window's end, never below 1", () => {
    const first = decideBurstHit(null, T0, 5, 60);
    expect(first.result.retryAfterSeconds).toBe(60);
    const late = decideBurstHit(first.next, T0 + 59_900, 5, 60);
    expect(late.result.retryAfterSeconds).toBe(1);
  });

  it("a new window opens once the old one has elapsed", () => {
    let state: BurstWindowState | null = null;
    for (let i = 0; i < 6; i++) state = decideBurstHit(state, T0, 5, 60).next;
    const after = decideBurstHit(state, T0 + 60_000, 5, 60);
    expect(after.result).toMatchObject({ success: true, count: 1 });
    expect(after.next.windowStart).toBe(T0 + 60_000);
  });

  it("the count is clamped, so a sustained flood cannot grow the stored value", () => {
    let state: BurstWindowState | null = null;
    for (let i = 0; i < 10_000; i++) state = decideBurstHit(state, T0, 5, 60).next;
    expect(state!.count).toBe(6);
  });

  it("a clock that went BACKWARDS opens a fresh window rather than trusting stale state", () => {
    const { next } = decideBurstHit(null, T0, 5, 60);
    const back = decideBurstHit({ ...next, count: 6 }, T0 - 1, 5, 60);
    expect(back.result.success).toBe(true);
  });
});

describe("OPE-951 — validateBurstArgs", () => {
  it.each([
    [0, 60],
    [-1, 60],
    [1.5, 60],
    [5, 0],
    [5, 3601],
    [Number.NaN, 60],
    ["5", 60],
  ])("rejects limit=%s period=%s", (l, p) => {
    expect(validateBurstArgs(l, p)).not.toBeNull();
  });

  it("accepts the production arguments", () => {
    expect(validateBurstArgs(5, 60)).toBeNull();
  });
});

/** A fake SQLite-backed DO state: synchronous kv, async alarm + deleteAll. */
function fakeState() {
  const kv = new Map<string, unknown>();
  const alarms: number[] = [];
  let deleted = 0;
  return {
    kv,
    alarms,
    get deleted() {
      return deleted;
    },
    ctx: {
      storage: {
        kv: {
          get: (k: string) => kv.get(k),
          put: (k: string, v: unknown) => void kv.set(k, v),
        },
        setAlarm: async (t: number) => void alarms.push(t),
        deleteAll: async () => {
          kv.clear();
          deleted++;
        },
      },
    },
  };
}

describe("OPE-951 — BurstCounter (the class)", () => {
  it("refuses the 6th hit on a 5/60 budget", async () => {
    const s = fakeState();
    const counter = new BurstCounter(s.ctx as never, {} as never);
    const results = [];
    for (let i = 0; i < 8; i++) results.push((await counter.hit(5, 60)).success);
    expect(results).toEqual([true, true, true, true, true, false, false, false]);
  });

  it("CONCURRENT hits are all counted — none reads a stale value", async () => {
    // Fire twenty without awaiting between them. Because the read and the
    // write are synchronous, each call has already written before the next
    // one starts, so exactly five succeed. (A read-modify-write with an await
    // between read and write — the KV quota's shape — lets all twenty read 0.)
    const s = fakeState();
    const counter = new BurstCounter(s.ctx as never, {} as never);
    const results = await Promise.all(Array.from({ length: 20 }, () => counter.hit(5, 60)));
    expect(results.filter((r) => r.success)).toHaveLength(5);
  });

  it("schedules ONE cleanup alarm per window, and the alarm clears storage", async () => {
    const s = fakeState();
    const counter = new BurstCounter(s.ctx as never, {} as never);
    for (let i = 0; i < 4; i++) await counter.hit(5, 60);
    expect(s.alarms).toHaveLength(1);
    expect(s.kv.size).toBe(1);
    await counter.alarm();
    expect(s.kv.size).toBe(0);
    expect(s.deleted).toBe(1);
  });

  it("throws on an invalid limit instead of silently disabling the cap", async () => {
    const s = fakeState();
    const counter = new BurstCounter(s.ctx as never, {} as never);
    await expect(counter.hit(0, 60)).rejects.toThrow(/limit must be/);
    expect(s.kv.size).toBe(0);
  });
});
