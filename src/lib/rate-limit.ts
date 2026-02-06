import { getRequestContext } from "@cloudflare/next-on-pages";
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
} as const;

export type RateLimitEndpoint = keyof typeof RATE_LIMITS;

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
 * Get the Cloudflare KV binding for rate limiting
 */
function getRateLimitKv(): KVNamespace | null {
  try {
    const { env } = getRequestContext();
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

  // Get KV binding
  const kv = getRateLimitKv();

  // If KV is not available (local dev without KV), allow all requests
  if (!kv) {
    console.warn("[Rate Limit] KV not available, allowing request");
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
