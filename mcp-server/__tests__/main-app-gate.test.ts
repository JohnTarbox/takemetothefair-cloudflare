import { describe, expect, it, beforeEach } from "vitest";
import {
  MAX_CONCURRENT_MAIN_APP_CALLS,
  isWorkerOom,
  withMainAppSlot,
  __resetMainAppGate,
} from "../src/main-app-gate.js";

beforeEach(() => __resetMainAppGate());

/** A task that reports peak observed concurrency into a shared counter. */
function tracker() {
  const state = { active: 0, peak: 0 };
  return {
    state,
    task: (release: Promise<void>) => async () => {
      state.active += 1;
      state.peak = Math.max(state.peak, state.active);
      await release;
      state.active -= 1;
    },
  };
}

describe("withMainAppSlot (OPE-489)", () => {
  it("never runs more than the cap concurrently", async () => {
    const { state, task } = tracker();
    let release!: () => void;
    const gateOpen = new Promise<void>((r) => (release = r));

    const runs = Array.from({ length: 8 }, () => withMainAppSlot(task(gateOpen)));
    // Let every queued task get as far as it can before any completes.
    await Promise.resolve();
    await Promise.resolve();
    expect(state.peak).toBeLessThanOrEqual(MAX_CONCURRENT_MAIN_APP_CALLS);

    release();
    await Promise.all(runs);
    expect(state.active).toBe(0);
    expect(state.peak).toBeLessThanOrEqual(MAX_CONCURRENT_MAIN_APP_CALLS);
  });

  it("releases the slot when the task THROWS, so one failure cannot wedge the gate", async () => {
    // The property that matters most: the daily batch is failsoft, so tasks do
    // reject in normal operation. A slot leaked on rejection would deadlock
    // every later sweep — a worse outage than the one being fixed.
    await expect(
      withMainAppSlot(async () => {
        throw new Error("sweep exploded");
      })
    ).rejects.toThrow("sweep exploded");

    let ran = false;
    await Promise.all(
      Array.from({ length: MAX_CONCURRENT_MAIN_APP_CALLS + 3 }, () =>
        withMainAppSlot(async () => {
          ran = true;
        })
      )
    );
    expect(ran).toBe(true);
  });

  it("runs all queued tasks, not just the first batch", async () => {
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 9 }, (_, i) =>
        withMainAppSlot(async () => {
          order.push(i);
        })
      )
    );
    expect(order).toHaveLength(9);
    expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("recognises the Cloudflare isolate-OOM body", () => {
    expect(isWorkerOom("Worker exceeded memory limit.")).toBe(true);
    expect(isWorkerOom("worker EXCEEDED MEMORY limit")).toBe(true);
    expect(isWorkerOom("")).toBe(false);
    expect(isWorkerOom(null)).toBe(false);
    expect(isWorkerOom("Internal Server Error")).toBe(false);
  });
});
