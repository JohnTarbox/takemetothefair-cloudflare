import { describe, it, expect, beforeEach } from "vitest";
import {
  checkIndexNowBreaker,
  computeCooldownMs,
  armIndexNowCooldown,
  clearIndexNowCooldown,
  getIndexNowPauseState,
  setIndexNowPaused,
  BASE_COOLDOWN_MS,
  MAX_COOLDOWN_MS,
  type BreakerKv,
} from "../indexnow-breaker";

// In-memory fake of the KV surface the breaker uses. TTL is ignored (the tests
// drive expiry via the injectable `now` argument instead).
function makeKv(): BreakerKv & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

describe("computeCooldownMs", () => {
  it("starts at the base cooldown on the first 429", () => {
    expect(computeCooldownMs(1, null)).toBe(BASE_COOLDOWN_MS);
  });

  it("doubles each consecutive 429", () => {
    expect(computeCooldownMs(2, null)).toBe(BASE_COOLDOWN_MS * 2);
    expect(computeCooldownMs(3, null)).toBe(BASE_COOLDOWN_MS * 4);
    expect(computeCooldownMs(4, null)).toBe(BASE_COOLDOWN_MS * 8);
  });

  it("caps at MAX_COOLDOWN_MS no matter how high the streak", () => {
    expect(computeCooldownMs(50, null)).toBe(MAX_COOLDOWN_MS);
  });

  it("honors a Retry-After longer than the escalated value", () => {
    const longRetry = BASE_COOLDOWN_MS * 10;
    expect(computeCooldownMs(1, longRetry)).toBe(longRetry);
  });

  it("ignores a Retry-After shorter than the escalated value", () => {
    expect(computeCooldownMs(3, 1000)).toBe(BASE_COOLDOWN_MS * 4);
  });

  it("clamps an absurd Retry-After to the cap", () => {
    expect(computeCooldownMs(1, MAX_COOLDOWN_MS * 5)).toBe(MAX_COOLDOWN_MS);
  });
});

describe("checkIndexNowBreaker", () => {
  let kv: ReturnType<typeof makeKv>;
  beforeEach(() => {
    kv = makeKv();
  });

  it("is not blocked with a null KV (fails open)", async () => {
    const state = await checkIndexNowBreaker(null);
    expect(state.blocked).toBe(false);
  });

  it("is not blocked on an empty KV", async () => {
    const state = await checkIndexNowBreaker(kv);
    expect(state.blocked).toBe(false);
    expect(state.reason).toBeNull();
  });

  it("blocks (reason 'paused') when the operator kill-switch is set", async () => {
    await kv.put("indexnow:paused", "1");
    const state = await checkIndexNowBreaker(kv);
    expect(state.blocked).toBe(true);
    expect(state.reason).toBe("paused");
  });

  it("pause wins over an active cooldown", async () => {
    await kv.put("indexnow:paused", "1");
    await kv.put("indexnow:cooldown_until", String(Date.now() + 100_000));
    const state = await checkIndexNowBreaker(kv);
    expect(state.reason).toBe("paused");
  });

  it("blocks while a cooldown is in the future and clears once it passes", async () => {
    const now = 1_000_000_000_000;
    await kv.put("indexnow:cooldown_until", String(now + 60_000));
    expect((await checkIndexNowBreaker(kv, now)).blocked).toBe(true);
    expect((await checkIndexNowBreaker(kv, now + 60_001)).blocked).toBe(false);
  });
});

describe("armIndexNowCooldown / clearIndexNowCooldown", () => {
  let kv: ReturnType<typeof makeKv>;
  beforeEach(() => {
    kv = makeKv();
  });

  it("arms a base cooldown on the first 429 and escalates on the next", async () => {
    const now = 1_000_000_000_000;
    const first = await armIndexNowCooldown(kv, null, now);
    expect(first).toBe(now + BASE_COOLDOWN_MS);

    const second = await armIndexNowCooldown(kv, null, now);
    expect(second).toBe(now + BASE_COOLDOWN_MS * 2);
  });

  it("a cleared cooldown resets the escalation back to base", async () => {
    const now = 1_000_000_000_000;
    await armIndexNowCooldown(kv, null, now);
    await armIndexNowCooldown(kv, null, now); // streak = 2
    await clearIndexNowCooldown(kv);
    expect(kv.store.has("indexnow:cooldown_until")).toBe(false);
    expect(kv.store.has("indexnow:consec_429")).toBe(false);

    const afterClear = await armIndexNowCooldown(kv, null, now);
    expect(afterClear).toBe(now + BASE_COOLDOWN_MS); // back to step 1
  });

  it("clear does NOT touch the operator pause key", async () => {
    await kv.put("indexnow:paused", "1");
    await armIndexNowCooldown(kv, null);
    await clearIndexNowCooldown(kv);
    expect(kv.store.get("indexnow:paused")).toBe("1");
  });

  it("is a no-op with a null KV", async () => {
    expect(await armIndexNowCooldown(null, null)).toBeNull();
    await expect(clearIndexNowCooldown(null)).resolves.toBeUndefined();
  });
});

describe("operator pause state (admin toggle)", () => {
  let kv: ReturnType<typeof makeKv>;
  beforeEach(() => {
    kv = makeKv();
  });

  it("reports unpaused on an empty KV", async () => {
    expect(await getIndexNowPauseState(kv)).toEqual({ paused: false, note: null });
  });

  it("setIndexNowPaused(true, note) pauses and round-trips the note", async () => {
    const ok = await setIndexNowPaused(kv, true, "stop now");
    expect(ok).toBe(true);
    expect(await getIndexNowPauseState(kv)).toEqual({ paused: true, note: "stop now" });
    // and the breaker now blocks with reason 'paused'
    expect((await checkIndexNowBreaker(kv)).reason).toBe("paused");
  });

  it("setIndexNowPaused(false) clears the flag", async () => {
    await setIndexNowPaused(kv, true, "x");
    await setIndexNowPaused(kv, false);
    expect(await getIndexNowPauseState(kv)).toEqual({ paused: false, note: null });
    expect((await checkIndexNowBreaker(kv)).blocked).toBe(false);
  });

  it("defaults an empty note to 'paused'", async () => {
    await setIndexNowPaused(kv, true, "   ");
    expect((await getIndexNowPauseState(kv)).note).toBe("paused");
  });

  it("fails closed (returns false) with a null KV so the API can surface it", async () => {
    expect(await setIndexNowPaused(null, true)).toBe(false);
    expect(await getIndexNowPauseState(null)).toEqual({ paused: false, note: null });
  });
});
