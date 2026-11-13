import { afterEach, describe, expect, it } from "vitest";
import { mapWithConcurrency } from "@/lib/concurrency";
import {
  HEARTBEAT_PROBES,
  HEARTBEAT_PROBE_CONCURRENCY,
  gatherHeartbeatActivity,
} from "@/lib/heartbeat";

const tick = () => new Promise<void>((r) => setTimeout(r, 1));

describe("OPE-1573 mapWithConcurrency", () => {
  it("never exceeds the limit and preserves input order", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 25 }, (_, i) => i);
    const out = await mapWithConcurrency(items, 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight--;
      return n * 2;
    });
    expect(out).toEqual(items.map((n) => n * 2));
    expect(peak).toBe(3); // landmark: the limit was actually reached, not just respected
  });

  it("rejects with the first error and stops taking new items", async () => {
    let started = 0;
    await expect(
      mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
        started++;
        await tick();
        if (n === 1) throw new Error("boom");
        return n;
      })
    ).rejects.toThrow("boom");
    expect(started).toBeLessThan(6);
  });

  it("handles an empty list and rejects a non-positive limit", async () => {
    await expect(mapWithConcurrency([], 4, async () => 1)).resolves.toEqual([]);
    await expect(mapWithConcurrency([1], 0, async () => 1)).rejects.toThrow(RangeError);
  });
});

describe("OPE-1573 gatherHeartbeatActivity bounds D1 fan-out", () => {
  const originals = HEARTBEAT_PROBES.map((p) => p.lastEvidenceAt);
  afterEach(() => {
    HEARTBEAT_PROBES.forEach((p, i) => {
      p.lastEvidenceAt = originals[i];
    });
  });

  it(`runs at most HEARTBEAT_PROBE_CONCURRENCY (${HEARTBEAT_PROBE_CONCURRENCY}) probe queries at once`, async () => {
    // Precondition: the burst this guards against is real — many probes.
    expect(HEARTBEAT_PROBES.length).toBeGreaterThan(HEARTBEAT_PROBE_CONCURRENCY * 4);

    let inFlight = 0;
    let peak = 0;
    let calls = 0;
    for (const p of HEARTBEAT_PROBES) {
      p.lastEvidenceAt = async () => {
        calls++;
        inFlight++;
        peak = Math.max(peak, inFlight);
        await tick();
        inFlight--;
        return null;
      };
    }
    const fakeDb = { select: () => ({ from: async () => [] }) };
    const out = await gatherHeartbeatActivity(fakeDb as never);

    expect(calls).toBe(HEARTBEAT_PROBES.length);
    expect(out.map((a) => a.probe.name)).toEqual(HEARTBEAT_PROBES.map((p) => p.name));
    expect(peak).toBe(HEARTBEAT_PROBE_CONCURRENCY);
  });
});
