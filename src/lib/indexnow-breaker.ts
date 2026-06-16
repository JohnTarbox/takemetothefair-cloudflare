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
// REL6 (2026-06-16): epoch-ms when the current uninterrupted 429 streak began.
// Set on the first 429 after a clear, preserved across subsequent 429s, and
// deleted on any 2xx (clearIndexNowCooldown) — so it measures CONSECUTIVE
// 429 time "with no 2xx in between".
const STREAK_START_KEY = "indexnow:streak_started_at";

/** First-429 cooldown. Matches Bing's observed ~15-min per-host window. */
export const BASE_COOLDOWN_MS = 15 * 60 * 1000;
/** Ceiling — converges to ~daily polling during a sustained penalty. */
export const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/**
 * REL6 auto-pause latch threshold. Once Bing has 429'd continuously for this
 * long (no 2xx in between), the breaker engages the operator kill-switch
 * automatically and signals the caller to email a human. NO self-healing —
 * the operator decides when to un-pause (Bing's penalty needs a quiet window
 * of ≥24–48h to decay; auto-resuming would just re-arm it). 6h is well past
 * the early escalation steps (15m→30m→1h→2h) and into the "this is sustained,
 * not a blip" zone.
 */
export const AUTO_PAUSE_AFTER_MS = 6 * 60 * 60 * 1000;

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

/** Outcome of arming the cooldown. `autoPaused` is true ONLY on the single
 *  call that trips the REL6 latch (unpaused → paused), so the caller emails
 *  the operator exactly once. */
export interface ArmResult {
  /** New cooldown expiry (epoch ms), or null if KV was unavailable. */
  until: number | null;
  /** Consecutive-429 count after this call. */
  consec: number;
  /** True iff this call auto-engaged the operator kill-switch. */
  autoPaused: boolean;
}

/**
 * Record a 429 from Bing: bump the consecutive counter, (re)arm the cooldown,
 * track the streak start, and — once the streak has lasted AUTO_PAUSE_AFTER_MS
 * with no 2xx in between — auto-engage the operator pause (REL6). Never throws.
 */
export async function armIndexNowCooldown(
  kv: BreakerKv | null,
  retryAfterMs: number | null,
  now: number = Date.now()
): Promise<ArmResult> {
  if (!kv) return { until: null, consec: 0, autoPaused: false };
  try {
    const prevRaw = await kv.get(CONSEC_KEY);
    const prev = Number(prevRaw ?? "0");
    const prevConsec = Number.isFinite(prev) ? prev : 0;
    const consec = prevConsec + 1;
    const cooldownMs = computeCooldownMs(consec, retryAfterMs);
    const until = now + cooldownMs;
    const ttlSeconds = Math.ceil(cooldownMs / 1000) + 60;

    // Streak start: a brand-new streak (no prior consecutive 429) anchors at
    // `now`; an ongoing streak keeps its original start so we measure TOTAL
    // continuous-429 duration. A 2xx wipes it via clearIndexNowCooldown.
    let streakStart = now;
    if (prevConsec > 0) {
      const s = Number(await kv.get(STREAK_START_KEY));
      if (Number.isFinite(s) && s > 0) streakStart = s;
    }

    // Keep the counter alive a bit longer than the cooldown so a probe right
    // after expiry still escalates rather than resetting to step 1.
    await kv.put(CONSEC_KEY, String(consec), { expirationTtl: Math.max(ttlSeconds * 2, 3600) });
    await kv.put(COOLDOWN_KEY, String(until), { expirationTtl: ttlSeconds });
    // Streak key must outlive even the 24h-capped cooldown so a daily probe
    // doesn't look like a fresh streak — TTL = 2× the max cooldown.
    await kv.put(STREAK_START_KEY, String(streakStart), {
      expirationTtl: Math.ceil(MAX_COOLDOWN_MS / 1000) * 2,
    });

    // REL6 latch. Engage the operator kill-switch once the streak crosses the
    // threshold; guard on "not already paused" so this transitions exactly
    // once (while paused, the breaker skips all Bing contact, so arm() won't
    // be reached again until an operator clears the pause).
    let autoPaused = false;
    if (now - streakStart >= AUTO_PAUSE_AFTER_MS) {
      const already = await kv.get(PAUSE_KEY);
      if (!already) {
        const hours = Math.max(1, Math.round((now - streakStart) / 3_600_000));
        await kv.put(
          PAUSE_KEY,
          `auto-paused ${new Date(now).toISOString()}: ${consec} consecutive 429s over ~${hours}h with no 2xx. Operator must clear to resume.`
        );
        autoPaused = true;
      }
    }

    return { until, consec, autoPaused };
  } catch {
    return { until: null, consec: 0, autoPaused: false };
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
    // REL6: a 2xx ends the streak — wipe its start so the next 429 begins a
    // fresh streak ("no 2xx in between" is enforced here).
    await kv.delete(STREAK_START_KEY);
  } catch {
    /* best-effort */
  }
}

/** Current operator kill-switch state, for the admin UI toggle. `note` is the
 *  free-text value stored alongside the flag (e.g. who paused it / why). */
export interface IndexNowPauseState {
  paused: boolean;
  note: string | null;
}

export async function getIndexNowPauseState(kv: BreakerKv | null): Promise<IndexNowPauseState> {
  if (!kv) return { paused: false, note: null };
  try {
    const v = await kv.get(PAUSE_KEY);
    return { paused: Boolean(v), note: v ?? null };
  } catch {
    return { paused: false, note: null };
  }
}

/**
 * Set or clear the operator kill-switch. `paused: true` writes PAUSE_KEY (with
 * an optional note); `false` deletes it. No TTL — a pause stays until explicitly
 * cleared. Never throws; returns true on success so the API can report failure.
 */
export async function setIndexNowPaused(
  kv: BreakerKv | null,
  paused: boolean,
  note?: string
): Promise<boolean> {
  if (!kv) return false;
  try {
    if (paused) {
      await kv.put(PAUSE_KEY, note && note.trim() ? note.trim() : "paused");
    } else {
      await kv.delete(PAUSE_KEY);
    }
    return true;
  } catch {
    return false;
  }
}
