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
  AUTO_PAUSE_AFTER_429_STREAK,
  AUTO_PAUSE_REASON,
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
    expect(first.until).toBe(now + BASE_COOLDOWN_MS);

    const second = await armIndexNowCooldown(kv, null, now);
    expect(second.until).toBe(now + BASE_COOLDOWN_MS * 2);
  });

  it("a cleared cooldown resets the escalation back to base", async () => {
    const now = 1_000_000_000_000;
    await armIndexNowCooldown(kv, null, now);
    await armIndexNowCooldown(kv, null, now); // streak = 2
    await clearIndexNowCooldown(kv);
    expect(kv.store.has("indexnow:cooldown_until")).toBe(false);
    expect(kv.store.has("indexnow:consec_429")).toBe(false);

    const afterClear = await armIndexNowCooldown(kv, null, now);
    expect(afterClear.until).toBe(now + BASE_COOLDOWN_MS); // back to step 1
  });

  it("clear does NOT touch the operator pause key", async () => {
    await kv.put("indexnow:paused", "1");
    await armIndexNowCooldown(kv, null);
    await clearIndexNowCooldown(kv);
    expect(kv.store.get("indexnow:paused")).toBe("1");
  });

  it("is a no-op with a null KV", async () => {
    const r = await armIndexNowCooldown(null, null);
    expect(r.until).toBeNull();
    expect(r.autoPaused).toBe(false);
    await expect(clearIndexNowCooldown(null)).resolves.toBeUndefined();
  });
});

describe("REL6 — auto-pause latch on a 3-consecutive-429 streak (count-based)", () => {
  let kv: ReturnType<typeof makeKv>;
  beforeEach(() => {
    kv = makeKv();
  });

  it("does NOT auto-pause before the streak reaches the threshold", async () => {
    const now = 1_000_000_000_000;
    // Two 429s — one short of AUTO_PAUSE_AFTER_429_STREAK (=3). Elapsed time is
    // irrelevant now; only the consecutive count matters.
    const a = await armIndexNowCooldown(kv, null, now);
    expect(a.consec).toBe(1);
    expect(a.autoPaused).toBe(false);
    const b = await armIndexNowCooldown(kv, null, now + 5 * 3_600_000); // 5h later
    expect(b.consec).toBe(2);
    expect(b.autoPaused).toBe(false);
    expect(kv.store.has("indexnow:paused")).toBe(false);
  });

  it("auto-pauses exactly once on the Nth consecutive 429, with the distinct reason", async () => {
    const now = 1_000_000_000_000;
    for (let i = 1; i < AUTO_PAUSE_AFTER_429_STREAK; i++) {
      const r = await armIndexNowCooldown(kv, null, now);
      expect(r.autoPaused).toBe(false);
    }
    const tripped = await armIndexNowCooldown(kv, null, now);
    expect(tripped.consec).toBe(AUTO_PAUSE_AFTER_429_STREAK);
    expect(tripped.autoPaused).toBe(true);
    expect(kv.store.get("indexnow:paused")).toMatch(new RegExp(`^${AUTO_PAUSE_REASON}`));

    // A subsequent arm (still paused) must NOT re-trip the latch.
    const again = await armIndexNowCooldown(kv, null, now);
    expect(again.autoPaused).toBe(false);
  });

  it("a 2xx before the Nth strike resets the count so it does NOT pause", async () => {
    const now = 1_000_000_000_000;
    await armIndexNowCooldown(kv, null, now); // consec 1
    await armIndexNowCooldown(kv, null, now); // consec 2
    await clearIndexNowCooldown(kv); // 2xx — counter wiped
    expect(kv.store.has("indexnow:consec_429")).toBe(false);

    // Fresh streak: two more 429s only reach consec 2 → no pause.
    const a = await armIndexNowCooldown(kv, null, now);
    expect(a.consec).toBe(1);
    const b = await armIndexNowCooldown(kv, null, now);
    expect(b.consec).toBe(2);
    expect(b.autoPaused).toBe(false);
    expect(kv.store.has("indexnow:paused")).toBe(false);
  });

  it("does not overwrite an existing operator pause note", async () => {
    const now = 1_000_000_000_000;
    await kv.put("indexnow:paused", "manual: paused by operator");
    for (let i = 0; i < AUTO_PAUSE_AFTER_429_STREAK + 1; i++) {
      const r = await armIndexNowCooldown(kv, null, now);
      expect(r.autoPaused).toBe(false); // already paused → no transition
    }
    expect(kv.store.get("indexnow:paused")).toBe("manual: paused by operator");
  });

  it("checkIndexNowBreaker surfaces the pause note so callers can classify it", async () => {
    // auto-latch note → distinguishable; manual note → not.
    await kv.put("indexnow:paused", `${AUTO_PAUSE_REASON} 2026-06-26: 3 consecutive 429s`);
    const auto = await checkIndexNowBreaker(kv);
    expect(auto.reason).toBe("paused");
    expect(auto.note?.startsWith(AUTO_PAUSE_REASON)).toBe(true);

    await kv.put("indexnow:paused", "manual: stop now");
    const manual = await checkIndexNowBreaker(kv);
    expect(manual.note?.startsWith(AUTO_PAUSE_REASON)).toBe(false);
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
