/**
 * OPE-935 — the email-and-password sign-in had NO rate limit.
 *
 * `authorize()` looked the user up and ran `verifyPassword` on every request, so
 * any account — admins included — could be guessed at the speed of the network.
 * The sibling routes (register, forgot/reset password, verify-email) were all
 * limited; sign-in, the one an attacker actually wants, was not. Measured before
 * building: 15 rapid POSTs to `/api/auth/callback/credentials` on production all
 * returned 302 with no edge 429, so no zone rule throttles it either.
 *
 * Two keys on the hard burst cap (the Durable Object counter, OPE-951), both hit
 * on every attempt:
 *
 *  - per client IP     — one machine cannot spray many accounts;
 *  - per account email — many machines cannot spray one account. The email is
 *    hashed, so the key never carries the address.
 *
 * Refused if EITHER is over. Hitting both keys every time is deliberate: an
 * attacker rotating IPs still spends the account's budget.
 *
 * ⚠️ The per-account key is also a lever: someone can hold a known admin email
 * over its budget and keep its owner out for the length of the attack (60 s at
 * a time). That trade is the ticket's explicit ask — guessing an admin password
 * is the worse outcome — and is recorded here so it is a decision, not a surprise.
 *
 * Failure posture:
 *  - no binding on a DEPLOYED Worker → refuse (fail closed; OPE-931's lesson);
 *  - no binding off a deployed Worker (tests, `next dev`) → allow;
 *  - the counter THROWS → allow, and log it. A Durable Object incident must not
 *    lock every user out of the site; the refusal is the thing that has failed,
 *    and it says so in the logs.
 */
import { getBurstLimiter } from "@/lib/burst-limiter";
import { isDeployedEnvironment } from "@/lib/runtime-env";
import { normalizeEmail } from "@/lib/auth/normalize-email";

export const SIGNIN_POLICY = "auth-signin";

export interface SignInThrottleResult {
  allowed: boolean;
  reason: "ok" | "ip-over-budget" | "account-over-budget" | "no-binding" | "limiter-threw";
}

function clientIp(request: Request | undefined): string {
  const h = request?.headers;
  return (
    h?.get("CF-Connecting-IP") ?? h?.get("X-Forwarded-For")?.split(",")[0]?.trim() ?? "unknown"
  );
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function signInKeys(request: Request | undefined, email: string) {
  const emailHash = (await sha256Hex(normalizeEmail(email))).slice(0, 32);
  return {
    ip: `rate:${SIGNIN_POLICY}:ip:${clientIp(request)}`,
    account: `rate:${SIGNIN_POLICY}:email:${emailHash}`,
  };
}

export async function signInThrottle(
  request: Request | undefined,
  email: string
): Promise<SignInThrottleResult> {
  const limiter = getBurstLimiter();
  if (!limiter) {
    return isDeployedEnvironment()
      ? { allowed: false, reason: "no-binding" }
      : { allowed: true, reason: "no-binding" };
  }
  const keys = await signInKeys(request, email);
  try {
    const [ip, account] = await Promise.all([
      limiter.limit({ key: keys.ip }),
      limiter.limit({ key: keys.account }),
    ]);
    if (!ip.success) return { allowed: false, reason: "ip-over-budget" };
    if (!account.success) return { allowed: false, reason: "account-over-budget" };
    return { allowed: true, reason: "ok" };
  } catch (error) {
    console.error("[auth] sign-in throttle threw; allowing this attempt", error);
    return { allowed: true, reason: "limiter-threw" };
  }
}
