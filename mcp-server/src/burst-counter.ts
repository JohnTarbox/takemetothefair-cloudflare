/**
 * OPE-951 — a HARD burst cap: one Durable Object per rate-limit key.
 *
 * ## Why this exists
 *
 * OPE-904 put the eight abuse-prone policies (register, forgot/reset password,
 * verify-email, newsletter, vendor-contact, suggest-event, claim-wizard) behind
 * the Workers Rate Limiting binding as the "hard cap the KV layer cannot
 * provide". Measured in production on 2026-09-11 and again 2026-09-13, that
 * binding returned `success: true` for every call — 7+ requests per colo inside
 * a 60 s window on a 5/60 s budget, none refused — while the SAME binding, same
 * `namespace_id`, same key shapes, refused at call 7 in an isolated
 * `wrangler dev --remote` Worker. Cloudflare documents it as "permissive,
 * eventually consistent, and intentionally designed to not be used as an
 * accurate accounting system", counted against per-machine cached values. It
 * is not a hard cap, and the policies it was chosen for need one.
 *
 * A Durable Object is. Every hit for a key is routed to the one instance named
 * by that key, which processes events one at a time.
 *
 * ## Why the read-and-write cannot interleave
 *
 * `hit()` reads and writes through `ctx.storage.kv`, the SYNCHRONOUS API of a
 * SQLite-backed Durable Object, with no `await` between the read and the write.
 * Nothing else can run inside that span, so two concurrent hits always see each
 * other's increment — the property the KV quota's read-modify-write lacks
 * (OPE-904: 81 requests, 27 increments recorded).
 *
 * ## Lifetime
 *
 * One instance per distinct key (policy × IP or user), so an attacker rotating
 * keys creates instances. Each schedules an alarm at the end of its window that
 * deletes its storage, so an idle key holds nothing.
 */
import { DurableObject } from "cloudflare:workers";

export interface BurstWindowState {
  /** ms-epoch the current window opened. */
  windowStart: number;
  /** Hits counted in this window, clamped at limit + 1. */
  count: number;
}

export interface BurstHitResult {
  success: boolean;
  /** Hits in the current window INCLUDING this one (clamped at limit + 1). */
  count: number;
  /** Seconds until the window resets — what a refusal's Retry-After should say. */
  retryAfterSeconds: number;
}

/** Bounds on what an RPC caller may ask for, so a bad argument cannot disable the cap. */
export const BURST_LIMIT_MAX = 1000;
export const BURST_PERIOD_MAX_SECONDS = 3600;

export function validateBurstArgs(limit: unknown, periodSeconds: unknown): string | null {
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > BURST_LIMIT_MAX) {
    return `limit must be an integer in [1, ${BURST_LIMIT_MAX}]`;
  }
  if (
    !Number.isInteger(periodSeconds) ||
    (periodSeconds as number) < 1 ||
    (periodSeconds as number) > BURST_PERIOD_MAX_SECONDS
  ) {
    return `periodSeconds must be an integer in [1, ${BURST_PERIOD_MAX_SECONDS}]`;
  }
  return null;
}

/**
 * The whole decision, pure. A fixed window that opens on the first hit: hits
 * 1..limit succeed, every later hit in the window is refused, and the window
 * closes `periodSeconds` after it opened.
 */
export function decideBurstHit(
  state: BurstWindowState | null | undefined,
  now: number,
  limit: number,
  periodSeconds: number
): { next: BurstWindowState; result: BurstHitResult } {
  const periodMs = periodSeconds * 1000;
  const live = state && now >= state.windowStart && now < state.windowStart + periodMs;
  const windowStart = live ? state.windowStart : now;
  const count = Math.min((live ? state.count : 0) + 1, limit + 1);
  return {
    next: { windowStart, count },
    result: {
      success: count <= limit,
      count,
      retryAfterSeconds: Math.max(1, Math.ceil((windowStart + periodMs - now) / 1000)),
    },
  };
}

const STATE_KEY = "w";

export class BurstCounter extends DurableObject {
  /**
   * Count one hit against this instance's key. RPC entry point — the main app
   * calls `env.BURST_COUNTER.get(idFromName(key)).hit(5, 60)`.
   *
   * Throws on invalid arguments rather than guessing: a caller that passes a
   * broken limit must see an error, not a silently disabled cap.
   */
  async hit(limit: number, periodSeconds: number): Promise<BurstHitResult> {
    const invalid = validateBurstArgs(limit, periodSeconds);
    if (invalid) throw new Error(`BurstCounter.hit: ${invalid}`);

    const now = Date.now();
    // Synchronous read → decide → synchronous write. No await in between.
    const state = this.ctx.storage.kv.get<BurstWindowState>(STATE_KEY);
    const { next, result } = decideBurstHit(state, now, limit, periodSeconds);
    this.ctx.storage.kv.put(STATE_KEY, next);

    if (next.windowStart !== state?.windowStart) {
      // A new window: schedule its cleanup. Setting an alarm replaces any
      // earlier one, so there is at most one per instance.
      await this.ctx.storage.setAlarm(next.windowStart + periodSeconds * 1000);
    }
    return result;
  }

  /** Window over — drop the state so an idle key costs nothing. */
  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
