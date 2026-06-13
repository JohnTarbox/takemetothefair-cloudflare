/**
 * IndexNow circuit breaker (REL4, 2026-06-13).
 *
 * Bing's IndexNow endpoint imposes a STICKY, escalating per-host penalty when
 * it sees too many submissions: once tripped, it 429s every request and the
 * block RE-ARMS on each fresh violation, so a host that keeps poking it can
 * never recover. #481 fixed the flush's silent-data-loss but the system still
 * had no memory of "Bing is throttling us" across requests — every write path
 * kept hitting a penalized host, re-arming the block daily (the daily discovery
 * cron's create-ping burst).
 *
 * This breaker gives `pingIndexNow` (the single choke point where Bing is
 * actually contacted) that memory, in `RATE_LIMIT_KV`:
 *
 * - `indexnow:paused`        — operator kill-switch. When set to any value, ALL
 *                              Bing contact is skipped (deferred enqueues still
 *                              work). Lets an operator stop the bleeding without
 *                              a redeploy and leave IndexNow quiet for ≥24–48h so
 *                              Bing's penalty can decay. Clear with `kv delete`.
 * - `indexnow:cooldown_until`— epoch-ms; while now < this, Bing contact is
 *                              skipped. Armed on a 429, cleared on a 2xx.
 * - `indexnow:consec_429`    — consecutive-429 counter driving the escalation.
 *
 * Escalation: 15m → 30m → 1h → 2h → … capped at 24h. Honors a `Retry-After`
 * longer than the escalated value. The net effect during an active penalty: a
 * few hourly probes, then back-off to ~daily polling — gentle enough for Bing's
 * block to decay instead of being perpetually re-armed.
 *
 * Fails OPEN: any KV error (or no KV binding, e.g. local build / unit tests)
 * means "not blocked" so a KV outage never silences indexing.
 */

const PAUSE_KEY = "indexnow:paused";
const COOLDOWN_KEY = "indexnow:cooldown_until";
const CONSEC_KEY = "indexnow:consec_429";

/** First-429 cooldown. Matches Bing's observed ~15-min per-host window. */
export const BASE_COOLDOWN_MS = 15 * 60 * 1000;
/** Ceiling — converges to ~daily polling during a sustained penalty. */
export const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** Minimal KV surface used here — keeps the module testable with a fake. */
export interface BreakerKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface BreakerState {
  /** True when Bing contact must be skipped right now. */
  blocked: boolean;
  /** "paused" | "cooldown" | null — why it's blocked, for logging/observability. */
  reason: "paused" | "cooldown" | null;
  /** Cooldown expiry (epoch ms) when reason === "cooldown", else null. */
  until: number | null;
}

const NOT_BLOCKED: BreakerState = { blocked: false, reason: null, until: null };

/**
 * Read the breaker state. Pause wins over cooldown. Fails open on any error.
 * `now` is injectable for deterministic tests.
 */
export async function checkIndexNowBreaker(
  kv: BreakerKv | null,
  now: number = Date.now()
): Promise<BreakerState> {
  if (!kv) return NOT_BLOCKED;
  try {
    const paused = await kv.get(PAUSE_KEY);
    if (paused) return { blocked: true, reason: "paused", until: null };

    const raw = await kv.get(COOLDOWN_KEY);
    if (raw) {
      const until = Number(raw);
      if (Number.isFinite(until) && until > now) {
        return { blocked: true, reason: "cooldown", until };
      }
    }
  } catch {
    /* fail open */
  }
  return NOT_BLOCKED;
}

/**
 * Escalating cooldown duration for the Nth consecutive 429. Honors a
 * `Retry-After` longer than the escalated value (Bing sometimes asks for more),
 * always clamped to MAX_COOLDOWN_MS. Pure — exported for unit testing.
 */
export function computeCooldownMs(consec429: number, retryAfterMs: number | null): number {
  const steps = Math.max(0, consec429 - 1);
  const escalated = Math.min(BASE_COOLDOWN_MS * 2 ** steps, MAX_COOLDOWN_MS);
  if (retryAfterMs !== null && retryAfterMs > escalated) {
    return Math.min(retryAfterMs, MAX_COOLDOWN_MS);
  }
  return escalated;
}

/**
 * Record a 429 from Bing: bump the consecutive counter and (re)arm the cooldown.
 * Returns the new cooldown expiry (epoch ms) or null if KV is unavailable.
 * Never throws.
 */
export async function armIndexNowCooldown(
  kv: BreakerKv | null,
  retryAfterMs: number | null,
  now: number = Date.now()
): Promise<number | null> {
  if (!kv) return null;
  try {
    const prevRaw = await kv.get(CONSEC_KEY);
    const prev = Number(prevRaw ?? "0");
    const consec = (Number.isFinite(prev) ? prev : 0) + 1;
    const cooldownMs = computeCooldownMs(consec, retryAfterMs);
    const until = now + cooldownMs;
    const ttlSeconds = Math.ceil(cooldownMs / 1000) + 60;
    // Keep the counter alive a bit longer than the cooldown so a probe right
    // after expiry still escalates rather than resetting to step 1.
    await kv.put(CONSEC_KEY, String(consec), { expirationTtl: Math.max(ttlSeconds * 2, 3600) });
    await kv.put(COOLDOWN_KEY, String(until), { expirationTtl: ttlSeconds });
    return until;
  } catch {
    return null;
  }
}

/**
 * Record a successful Bing submission: clear the cooldown and reset the
 * consecutive-429 counter. Never throws. Does NOT touch the operator pause key.
 */
export async function clearIndexNowCooldown(kv: BreakerKv | null): Promise<void> {
  if (!kv) return;
  try {
    await kv.delete(COOLDOWN_KEY);
    await kv.delete(CONSEC_KEY);
  } catch {
    /* best-effort */
  }
}
