/**
 * OPE-900 step 4 — POST /authorize checked a password on every request, with
 * no limit, for an OAuth server whose tokens reach the admin tool set.
 *
 * Built on the BurstCounter Durable Object (OPE-951), which lives in THIS
 * Worker — the Workers Rate Limiting binding the ticket named was measured
 * enforcing nothing in prod (25 requests, 25 rows, against a 5/60 s budget), so
 * a `[[ratelimits]]` block here would have shipped an inert control.
 *
 * Two keys, both hit on every attempt, refused if EITHER is over:
 *
 *  - per client IP, 5 / 60 s — one machine cannot guess at speed;
 *  - per account, 10 / 60 s — many machines cannot spray one account. The
 *    email is hashed, so the key never carries the address.
 *
 * ⚠️ The account budget is deliberately LARGER than the IP one, unlike the
 * main app's sign-in throttle (OPE-935: 5 and 5). The ticket's acceptance is
 * "six wrong passwords from one IP → the 6th is 429; the correct password from
 * a different IP in the same window → success". With equal budgets the six
 * wrong guesses would spend the account's budget too and lock its owner out —
 * which is exactly what an attacker holding a known admin email would want.
 * At 10, one IP is stopped at 5 guesses and a legitimate sign-in from anywhere
 * else still has room; a distributed attack is still capped at 10 a minute.
 *
 * Failure posture:
 *  - no binding → REFUSE. The binding is declared in this Worker's own
 *    wrangler.toml, so its absence is a broken deploy, not an environment
 *    without one — and a guard that silently allows is the OPE-931 failure;
 *  - the counter THROWS → allow, and log. A Durable Object incident must not
 *    lock every user out of every connector.
 */
import type { BurstHitResult } from "../burst-counter.js";

export const AUTHORIZE_POLICY = "mcp-oauth-authorize";
export const AUTHORIZE_PERIOD_SECONDS = 60;
export const AUTHORIZE_IP_LIMIT = 5;
export const AUTHORIZE_ACCOUNT_LIMIT = 10;

/** The slice of the DO namespace this needs — structural, so tests can fake it. */
export interface BurstCounterNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): { hit(limit: number, periodSeconds: number): Promise<BurstHitResult> };
}

export type AuthorizeThrottleResult =
  | { allowed: true; reason: "ok" | "limiter-threw"; error?: unknown }
  | {
      allowed: false;
      reason: "ip-over-budget" | "account-over-budget" | "no-binding";
      retryAfterSeconds: number;
    };

export function clientIp(request: Request): string {
  const h = request.headers;
  return h.get("CF-Connecting-IP") ?? h.get("X-Forwarded-For")?.split(",")[0]?.trim() ?? "unknown";
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function authorizeKeys(ip: string, email: string) {
  const emailHash = (await sha256Hex(email.trim().toLowerCase())).slice(0, 32);
  return {
    ip: `rate:${AUTHORIZE_POLICY}:ip:${ip}`,
    account: `rate:${AUTHORIZE_POLICY}:email:${emailHash}`,
  };
}

export async function throttleAuthorize(
  counter: BurstCounterNamespace | undefined,
  ip: string,
  email: string
): Promise<AuthorizeThrottleResult> {
  if (!counter) {
    return { allowed: false, reason: "no-binding", retryAfterSeconds: AUTHORIZE_PERIOD_SECONDS };
  }
  const keys = await authorizeKeys(ip, email);
  const hit = (key: string, limit: number) =>
    counter.get(counter.idFromName(key)).hit(limit, AUTHORIZE_PERIOD_SECONDS);
  try {
    const [byIp, byAccount] = await Promise.all([
      hit(keys.ip, AUTHORIZE_IP_LIMIT),
      hit(keys.account, AUTHORIZE_ACCOUNT_LIMIT),
    ]);
    if (!byIp.success) {
      return {
        allowed: false,
        reason: "ip-over-budget",
        retryAfterSeconds: byIp.retryAfterSeconds,
      };
    }
    if (!byAccount.success) {
      return {
        allowed: false,
        reason: "account-over-budget",
        retryAfterSeconds: byAccount.retryAfterSeconds,
      };
    }
    return { allowed: true, reason: "ok" };
  } catch (error) {
    return { allowed: true, reason: "limiter-threw", error };
  }
}
