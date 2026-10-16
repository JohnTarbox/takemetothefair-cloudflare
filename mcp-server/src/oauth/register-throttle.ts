/**
 * OPE-1391 (LIB3) — POST /register (RFC 7591 dynamic client registration) was
 * open with no rate limit: every call writes a `client:<id>` record to
 * OAUTH_KV (shared with Cardworks), so one machine could fill it at speed.
 *
 * Same counter and failure posture as the /authorize throttle (OPE-900 step 4,
 * authorize-throttle.ts) — the BurstCounter Durable Object, because the Workers
 * Rate Limiting binding was measured enforcing nothing in prod (OPE-951):
 *
 *  - per client IP, 10 / hour. A connector registers when it is (re)connected,
 *    not per request or per refresh, so 10 an hour from one address is far
 *    above legitimate use and far below a flood;
 *  - no binding → REFUSE (it is declared in this Worker's own wrangler.toml, so
 *    its absence is a broken deploy, and a guard that silently allows is OPE-931);
 *  - the counter THROWS → allow. A Durable Object incident must not stop every
 *    user connecting a connector.
 *
 * Registration lifetime is NOT changed here: @cloudflare/workers-oauth-provider
 * 1.2.1 already defaults `clientRegistrationTTL` to 90 days and renews a client
 * past half its TTL on every successful token response
 * (`renewClientRegistrationIfDue`, dist/oauth-provider.js:2622, :4315), so a
 * client in active use never expires and an abandoned one ages out.
 */
import { clientIp, type BurstCounterNamespace } from "./authorize-throttle.js";
import { logError } from "../logger.js";

export const REGISTER_POLICY = "mcp-oauth-register";
export const REGISTER_PERIOD_SECONDS = 3600;
export const REGISTER_IP_LIMIT = 10;

export type RegisterThrottleResult =
  | { allowed: true; reason: "ok" | "limiter-threw"; error?: unknown }
  | { allowed: false; reason: "ip-over-budget" | "no-binding"; retryAfterSeconds: number };

export function registerKey(ip: string): string {
  return `rate:${REGISTER_POLICY}:ip:${ip}`;
}

export async function throttleRegister(
  counter: BurstCounterNamespace | undefined,
  ip: string
): Promise<RegisterThrottleResult> {
  if (!counter) {
    return { allowed: false, reason: "no-binding", retryAfterSeconds: REGISTER_PERIOD_SECONDS };
  }
  try {
    const hit = await counter
      .get(counter.idFromName(registerKey(ip)))
      .hit(REGISTER_IP_LIMIT, REGISTER_PERIOD_SECONDS);
    if (!hit.success) {
      return { allowed: false, reason: "ip-over-budget", retryAfterSeconds: hit.retryAfterSeconds };
    }
    return { allowed: true, reason: "ok" };
  } catch (error) {
    return { allowed: true, reason: "limiter-threw", error };
  }
}

/** The RFC 7591 error body a refused registration returns. */
export function registerRefusedResponse(retryAfterSeconds: number): Response {
  return new Response(
    JSON.stringify({
      error: "too_many_requests",
      error_description: `Too many client registrations. Retry in ${retryAfterSeconds} seconds.`,
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSeconds),
        "Cache-Control": "no-store",
      },
    }
  );
}

/**
 * The Worker-level gate: `null` → let the request through to OAuthProvider;
 * a Response → return it as is. Only POST /register is counted.
 */
export async function guardClientRegistration(
  request: Request,
  env: { DB?: D1Database; BURST_COUNTER?: BurstCounterNamespace }
): Promise<Response | null> {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/register") return null;
  const throttle = await throttleRegister(env.BURST_COUNTER, clientIp(request));
  if (!throttle.allowed) {
    // Console only for an over-budget refusal: a D1 row per refused request
    // would turn a registration flood into a D1 write flood. A missing binding
    // is a broken deploy and IS persisted.
    if (throttle.reason === "no-binding") {
      await logError(env.DB, {
        source: "mcp:oauth",
        message: "POST /register refused: BURST_COUNTER binding missing",
      });
    } else {
      console.warn(`[MCP] POST /register refused: ${throttle.reason}`);
    }
    return registerRefusedResponse(throttle.retryAfterSeconds);
  }
  if (throttle.reason === "limiter-threw") {
    await logError(env.DB, {
      level: "warn",
      source: "mcp:oauth",
      message: "POST /register allowed: rate limiter threw",
      error: throttle.error,
    });
  }
  return null;
}
