import { getCloudflareContext } from "@opennextjs/cloudflare";
import { isDeployedEnvironment } from "@/lib/runtime-env";
import { auth } from "@/lib/auth";

// Rate limit configuration per endpoint
export interface RateLimitConfig {
  anonymousLimit: number;
  authenticatedLimit: number;
  windowMs: number; // Window in milliseconds (e.g., 3600000 for 1 hour)
}

// Pre-configured limits for suggest-event endpoints
export const RATE_LIMITS = {
  "suggest-event-submit": {
    anonymousLimit: 3,
    authenticatedLimit: 10,
    windowMs: 60 * 60 * 1000, // 1 hour
  },
  "suggest-event-extract": {
    anonymousLimit: 5,
    authenticatedLimit: 15,
    windowMs: 60 * 60 * 1000,
  },
  "suggest-event-fetch": {
    anonymousLimit: 10,
    authenticatedLimit: 30,
    windowMs: 60 * 60 * 1000,
  },
  "suggest-event-check-duplicate": {
    anonymousLimit: 20,
    authenticatedLimit: 60,
    windowMs: 60 * 60 * 1000,
  },
  "suggest-event-match-venue": {
    anonymousLimit: 20,
    authenticatedLimit: 60,
    windowMs: 60 * 60 * 1000,
  },
  // Registration rate limiting - strict to prevent abuse
  "auth-register": {
    anonymousLimit: 5,
    authenticatedLimit: 5, // Already logged in users shouldn't register
    windowMs: 60 * 60 * 1000, // 1 hour
  },
  // Password reset request - strict to prevent enumeration + email spam
  "auth-forgot-password": {
    anonymousLimit: 5,
    authenticatedLimit: 5,
    windowMs: 60 * 60 * 1000, // 1 hour
  },
  // Password reset completion - prevent token brute-force
  "auth-reset-password": {
    anonymousLimit: 10,
    authenticatedLimit: 10,
    windowMs: 60 * 60 * 1000,
  },
  // Email verification send/resend
  "auth-verify-email-send": {
    anonymousLimit: 3,
    authenticatedLimit: 5,
    windowMs: 60 * 60 * 1000,
  },
  // Newsletter signup from footer form
  "newsletter-subscribe": {
    anonymousLimit: 10,
    authenticatedLimit: 10,
    windowMs: 60 * 60 * 1000,
  },
  // Export endpoints - authenticated only, moderate limits
  "export-events": {
    anonymousLimit: 0, // Must be authenticated
    authenticatedLimit: 10,
    windowMs: 60 * 60 * 1000, // 1 hour
  },
  "export-venues": {
    anonymousLimit: 0, // Must be authenticated
    authenticatedLimit: 10,
    windowMs: 60 * 60 * 1000, // 1 hour
  },
  "export-vendors": {
    anonymousLimit: 0, // Must be authenticated
    authenticatedLimit: 10,
    windowMs: 60 * 60 * 1000, // 1 hour
  },
  // Google Places API proxies - authenticated only, moderate limits
  "google-autocomplete": {
    anonymousLimit: 0,
    authenticatedLimit: 100,
    windowMs: 60 * 60 * 1000, // 1 hour
  },
  "google-place-details": {
    anonymousLimit: 0,
    authenticatedLimit: 60,
    windowMs: 60 * 60 * 1000, // 1 hour
  },
  "google-url-resolve": {
    anonymousLimit: 0,
    authenticatedLimit: 30,
    windowMs: 60 * 60 * 1000, // 1 hour
  },
  // Client-side error reporting - anon-friendly, prevents log flooding
  "client-errors": {
    anonymousLimit: 60,
    authenticatedLimit: 120,
    windowMs: 60 * 60 * 1000, // 1 hour
  },
  // First-party analytics beacon — moderate cap to prevent log flooding
  // while allowing normal browsing patterns (clicks, filter changes).
  "analytics-track": {
    anonymousLimit: 60,
    authenticatedLimit: 120,
    windowMs: 60 * 60 * 1000, // 1 hour
  },
  // Enhanced Profile vendor contact form — strict to prevent spam since
  // each successful POST forwards an email. Anonymous-only in practice
  // (the form is on a public page) so the authenticated cap mirrors.
  "vendor-contact": {
    anonymousLimit: 5,
    authenticatedLimit: 10,
    windowMs: 60 * 60 * 1000, // 1 hour
  },
  // Claim wizard verification POST (OPE-64) — per-user (auth-gated route).
  // Each POST can transfer ownership, so keep the cap tight; a legitimate user
  // resolves a claim in one or two attempts. Anonymous is 0 (route is withAuth).
  "claim-wizard": {
    anonymousLimit: 0,
    authenticatedLimit: 15,
    windowMs: 60 * 60 * 1000, // 1 hour
  },
  // "Other events on these dates" widget on /events/[slug]. Lazy-fired
  // from a user button click, so well-behaved traffic is far below
  // these caps; the cap is here to prevent a misbehaving client from
  // spamming the endpoint.
  "events-same-day": {
    anonymousLimit: 60,
    authenticatedLimit: 120,
    windowMs: 60 * 60 * 1000, // 1 hour
  },
  // OPE-211 increment 3 — vendor self-service gallery upload. John's greenlight
  // asked for one explicitly: "Rate limit the self-service upload path …
  // typical failure modes are enthusiastic new vendors + bots. Small budget per
  // vendor per day is fine."
  //
  // Anonymous is 0 because the route requires a session — the number is there
  // so an unauthenticated flood is refused by the cheap check before it reaches
  // auth, not because anonymous upload is a supported path.
  "vendor-photo-upload": {
    anonymousLimit: 0,
    authenticatedLimit: 20,
    windowMs: 24 * 60 * 60 * 1000, // 1 day
  },
  // OPE-972 — the three routes that spend metered Browser Rendering / Workers AI
  // per call. All three are gated (admin session or X-Internal-Key), so the
  // exposure is billing and runaway automation, not anonymous abuse. They are
  // called through checkRateLimit's `metered` option: keyed by the caller the
  // route already knows, and FAIL-CLOSED (see there).
  //
  // Sized from the account's own 30-day reading (2026-08-14 → 09-13): Browser
  // Rendering ≈ 5 sessions / 31s of browser time in total; zero OCR attempts on
  // extract-image and zero Browser Rendering attempts in the retained error log.
  // So these are CEILINGS on a runaway, far above real use — not throttles on
  // normal work. anonymousLimit 0: none of these has an anonymous path.
  //
  // KV quota layer only — deliberately NOT in BURST_POLICIES. TODO(OPE-951):
  // reconsider once the burst layer is proven to enforce.
  "import-url-fetch": {
    anonymousLimit: 0,
    // Each call may escalate to Browser Rendering at most twice.
    authenticatedLimit: 60,
    windowMs: 60 * 60 * 1000, // 1 hour
  },
  "import-url-extract-image": {
    anonymousLimit: 0,
    // Each call OCRs up to 5 images × 2 attempts = 10 Workers AI calls.
    authenticatedLimit: 30,
    windowMs: 60 * 60 * 1000,
  },
  "harvest-fetch": {
    anonymousLimit: 0,
    // Automation: a sitemap harvest legitimately fetches in batches, so the
    // window is a day, not an hour. Replaces the old global 60/min cap, which
    // failed open and allowed 86,400 calls a day.
    authenticatedLimit: 2000,
    windowMs: 24 * 60 * 60 * 1000,
  },
} as const;

export type RateLimitEndpoint = keyof typeof RATE_LIMITS;

/**
 * OPE-904 — the eight policies that get the BURST layer as well as the KV
 * quota (John's ruling 2026-09-10: option (c) here, option (a) everywhere else).
 *
 * These are the routes where a burst is the attack: each one either creates an
 * account, sends mail, moves ownership, or writes a public record. The other
 * fourteen keep KV alone and are documented as SOFT below.
 */
const BURST_POLICIES: ReadonlySet<RateLimitEndpoint> = new Set([
  "auth-register",
  "auth-forgot-password",
  "auth-reset-password",
  "auth-verify-email-send",
  "newsletter-subscribe",
  "vendor-contact",
  "suggest-event-submit",
  "claim-wizard",
]);

// OPE-935 — the burst-limiter primitives live in ./burst-limiter so the sign-in
// path (src/lib/auth.ts) can use them without importing this module, which
// imports `auth` and would make the two modules import each other.
export {
  BURST_LIMIT,
  BURST_WINDOW_SECONDS,
  getBurstLimiter,
  type BurstLimiter,
} from "@/lib/burst-limiter";
import { BURST_WINDOW_SECONDS, getBurstLimiter } from "@/lib/burst-limiter";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetAt: number; // Unix timestamp in seconds
  isAuthenticated: boolean;
}

/**
 * Get the client IP address from the request
 * Cloudflare provides the real client IP via CF-Connecting-IP header
 */
function getClientIp(request: Request): string {
  // Cloudflare provides the real client IP
  const cfIp = request.headers.get("CF-Connecting-IP");
  if (cfIp) return cfIp;

  // Fallback for local development
  const forwardedFor = request.headers.get("X-Forwarded-For");
  if (forwardedFor) {
    return forwardedFor.split(",")[0].trim();
  }

  return "unknown";
}

/**
 * Get the Cloudflare KV binding for rate limiting.
 *
 * ⚠️ The KV layer is a SOFT, BEST-EFFORT quota and must not be read as a hard
 * cap (OPE-904, option (a) for the fourteen policies that have only this).
 *
 * It is a read-modify-write across an eventually-consistent store: concurrent
 * requests read the same count and each writes back its own view, so increments
 * are LOST under exactly the burst it exists to stop. Measured on production
 * 2026-09-10: 81 origin-reaching requests against a 60/hour cap produced 27
 * recorded increments and zero refusals.
 *
 * It still earns its place — it is the only thing that can express an hourly or
 * daily quota, which the Workers binding cannot (period is 10s or 60s only) —
 * but treat it as attrition, not enforcement.
 */
function getRateLimitKv(): KVNamespace | null {
  try {
    const { env } = getCloudflareContext();
    return (env as { RATE_LIMIT_KV?: KVNamespace }).RATE_LIMIT_KV ?? null;
  } catch {
    return null;
  }
}

/**
 * Implements a sliding window counter rate limiting algorithm using Cloudflare KV
 *
 * Key format: `rate:{endpoint}:{identifier}`
 * Value format: JSON array of timestamps within the current window
 */
/**
 * OPE-972 — options for a route that spends metered resources per call.
 *
 * `identifier` is the already-authorized caller, supplied by the route (which
 * knows it better than a session lookup would: an X-Internal-Key caller has no
 * session at all). It is counted against `authenticatedLimit`.
 *
 * Metered calls are FAIL-CLOSED: with no KV binding, or a KV read/write that
 * throws, the request is refused. Every other policy allows in dev and fails
 * open on a KV error, which is right for a login form and wrong for an endpoint
 * that bills per call — one that cannot find out its quota must not spend.
 */
export interface MeteredRateLimitOptions {
  metered: { identifier: string };
}

/**
 * The key a metered route counts under. Session user first; otherwise the MCP
 * entrypoint stamp for internal callers, because every internal call arrives
 * from the same place and an IP key would put all of them in one bucket; the
 * client IP only as a last resort.
 */
export function meteredCallerIdentifier(request: Request, userId: string | null): string {
  if (userId) return `user:${userId}`;
  const entrypoint = request.headers.get("x-mmatf-entrypoint");
  if (entrypoint) return `caller:${entrypoint}`;
  return `ip:${getClientIp(request)}`;
}

export async function checkRateLimit(
  request: Request,
  endpoint: RateLimitEndpoint,
  options?: MeteredRateLimitOptions
): Promise<RateLimitResult> {
  const config = RATE_LIMITS[endpoint];
  const now = Date.now();
  const windowStart = now - config.windowMs;
  const failClosed = options?.metered !== undefined;

  // Check if user is authenticated
  let userId: string | null = null;
  let isAuthenticated = false;

  if (options?.metered) {
    isAuthenticated = true; // the route authorized the caller before calling
  } else {
    try {
      const session = await auth();
      if (session?.user?.id) {
        userId = session.user.id;
        isAuthenticated = true;
      }
    } catch {
      // Auth check failed, treat as anonymous
    }
  }

  // Determine rate limit based on auth status
  const limit = isAuthenticated ? config.authenticatedLimit : config.anonymousLimit;

  // Build the rate limit key
  const identifier =
    options?.metered?.identifier ??
    (isAuthenticated && userId ? `user:${userId}` : `ip:${getClientIp(request)}`);
  const key = `rate:${endpoint}:${identifier}`;
  const refuse = (): RateLimitResult => ({
    allowed: false,
    remaining: 0,
    limit,
    resetAt: Math.floor((now + config.windowMs) / 1000),
    isAuthenticated,
  });

  // OPE-904 / OPE-951 — BURST layer, before the KV quota. This is the half that
  // holds under concurrency: one Durable Object per key counts every hit in
  // order, so parallel requests cannot all read the same value.
  //
  // Failure posture (OPE-970) — both non-answers fall through to the KV quota:
  //   - NO binding (unit tests, `next dev`): skip this layer.
  //   - a limiter that THROWS: log it with the endpoint, then skip this layer.
  // Neither is the fail-open shape of OPE-931, because the KV quota still runs
  // — the request is still checked, it only loses the burst half — and neither
  // can turn into a 500. A throw is logged rather than swallowed, because a
  // burst layer that has quietly stopped working is exactly OPE-951.
  // A refusal is not an error, and returns 429 directly.
  if (BURST_POLICIES.has(endpoint)) {
    const burst = getBurstLimiter();
    if (burst) {
      let verdict: { success: boolean; retryAfterSeconds?: number } | null = null;
      try {
        verdict = await burst.limit({ key });
      } catch (error) {
        console.error(
          `[Rate Limit] burst limiter threw for ${endpoint}; falling through to the KV quota`,
          error
        );
      }
      if (verdict && !verdict.success) {
        return {
          allowed: false,
          remaining: 0,
          limit,
          // The burst window, not the policy's — Retry-After must describe the
          // limit that actually refused, or the caller waits an hour for a
          // 60-second block. The counter reports the time left in ITS window;
          // clamp so a bad value can never exceed the window.
          resetAt:
            Math.floor(now / 1000) +
            Math.min(
              BURST_WINDOW_SECONDS,
              Math.max(1, verdict.retryAfterSeconds ?? BURST_WINDOW_SECONDS)
            ),
          isAuthenticated,
        };
      }
    }
  }

  // Get KV binding
  const kv = getRateLimitKv();

  // If KV is not available, allow in dev but deny in production
  if (!kv) {
    // OPE-931 — one shared predicate; see src/lib/runtime-env.ts.
    const isProduction = isDeployedEnvironment();
    if (failClosed) {
      // OPE-972 — a metered route with no quota backend refuses in every
      // environment, dev included: the call it would make is still billed.
      console.error(`[Rate Limit] KV not available for metered ${endpoint} — denying request`);
      return refuse();
    }
    if (isProduction) {
      console.error("[Rate Limit] KV not available in production — denying request");
      return {
        allowed: false,
        remaining: 0,
        limit,
        resetAt: Math.floor((now + config.windowMs) / 1000),
        isAuthenticated,
      };
    }
    console.warn("[Rate Limit] KV not available, allowing request (dev mode)");
    return {
      allowed: true,
      remaining: limit - 1,
      limit,
      resetAt: Math.floor((now + config.windowMs) / 1000),
      isAuthenticated,
    };
  }

  try {
    // Get current request timestamps
    const stored = await kv.get(key);
    let timestamps: number[] = stored ? JSON.parse(stored) : [];

    // Filter out timestamps outside the current window (sliding window)
    timestamps = timestamps.filter((ts) => ts > windowStart);

    // Calculate remaining requests
    const remaining = Math.max(0, limit - timestamps.length - 1);
    const allowed = timestamps.length < limit;

    // Calculate reset time (oldest timestamp + window, or now + window if empty)
    const oldestTimestamp = timestamps.length > 0 ? Math.min(...timestamps) : now;
    const resetAt = Math.floor((oldestTimestamp + config.windowMs) / 1000);

    if (allowed) {
      // Add current request timestamp and store
      timestamps.push(now);

      // Calculate TTL: window duration + small buffer (in seconds)
      const ttlSeconds = Math.ceil(config.windowMs / 1000) + 60;

      await kv.put(key, JSON.stringify(timestamps), {
        expirationTtl: ttlSeconds,
      });
    }

    return {
      allowed,
      remaining: allowed ? remaining : 0,
      limit,
      resetAt,
      isAuthenticated,
    };
  } catch (error) {
    if (failClosed) {
      // OPE-972 — fail CLOSED for metered routes; see MeteredRateLimitOptions.
      console.error(`[Rate Limit] KV error on metered ${endpoint} — denying request:`, error);
      return refuse();
    }
    // On KV error, log and allow the request (fail open)
    console.error("[Rate Limit] KV error:", error);
    return {
      allowed: true,
      remaining: limit - 1,
      limit,
      resetAt: Math.floor((now + config.windowMs) / 1000),
      isAuthenticated,
    };
  }
}

/**
 * Creates a 429 Too Many Requests response with proper headers
 */
export function rateLimitResponse(result: RateLimitResult): Response {
  const retryAfter = Math.max(0, result.resetAt - Math.floor(Date.now() / 1000));

  return new Response(
    JSON.stringify({
      success: false,
      error: "Too many requests. Please try again later.",
      retryAfter,
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfter),
        "X-RateLimit-Limit": String(result.limit),
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": String(result.resetAt),
      },
    }
  );
}
