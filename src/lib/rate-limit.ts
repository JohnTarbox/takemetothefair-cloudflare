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

/** The binding's period is fixed at 60s in wrangler.toml; used for Retry-After. */
const BURST_WINDOW_SECONDS = 60;

export interface RateLimiterBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * The Workers Rate Limiting binding — a HARD cap enforced by the runtime, in
 * contrast to the KV quota below.
 *
 * ⚠️ This docblock previously sat here describing the KV layer's lossiness,
 * which is the opposite of what this binding does. It has been moved onto
 * `getRateLimitKv`, where it belongs. The distinction is load-bearing: callers
 * choose this binding precisely when they need a cap that cannot be outrun.
 *
 * The binding is configured once in `wrangler.toml` (`limit = 5`,
 * `period = 60`) and that budget applies PER KEY, so unrelated callers get
 * independent buckets by choosing distinct key namespaces. Two use it today:
 * the eight `BURST_POLICIES` above, and the internal-key refusal log in
 * `api-auth.ts`.
 */
export function getBurstLimiter(): RateLimiterBinding | null {
  try {
    const { env } = getCloudflareContext();
    return (env as { BURST_LIMITER?: RateLimiterBinding }).BURST_LIMITER ?? null;
  } catch {
    return null;
  }
}

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
export async function checkRateLimit(
  request: Request,
  endpoint: RateLimitEndpoint
): Promise<RateLimitResult> {
  const config = RATE_LIMITS[endpoint];
  const now = Date.now();
  const windowStart = now - config.windowMs;

  // Check if user is authenticated
  let userId: string | null = null;
  let isAuthenticated = false;

  try {
    const session = await auth();
    if (session?.user?.id) {
      userId = session.user.id;
      isAuthenticated = true;
    }
  } catch {
    // Auth check failed, treat as anonymous
  }

  // Determine rate limit based on auth status
  const limit = isAuthenticated ? config.authenticatedLimit : config.anonymousLimit;

  // Build the rate limit key
  const identifier = isAuthenticated && userId ? `user:${userId}` : `ip:${getClientIp(request)}`;
  const key = `rate:${endpoint}:${identifier}`;

  // OPE-904 — BURST layer, before the KV quota. This is the half that actually
  // holds under concurrency: the binding counts at the edge with no
  // read-modify-write, so parallel requests cannot all read the same value.
  //
  // Absent binding (unit tests, `next dev`) skips this layer and falls through
  // to KV. That is deliberate and is NOT the fail-open shape of OPE-931: the KV
  // quota still runs, so the request is still checked — it just loses the burst
  // half. A missing binding cannot make an unchecked request look checked.
  if (BURST_POLICIES.has(endpoint)) {
    const burst = getBurstLimiter();
    if (burst) {
      const { success } = await burst.limit({ key });
      if (!success) {
        return {
          allowed: false,
          remaining: 0,
          limit,
          // The binding's window, not the policy's — Retry-After must describe
          // the limit that actually refused, or the caller waits an hour for a
          // 60-second block.
          resetAt: Math.floor(now / 1000) + BURST_WINDOW_SECONDS,
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
