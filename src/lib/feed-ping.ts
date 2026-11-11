/**
 * OPE-1621 — the public change ping, `POST /api/v1/ping`.
 *
 * An organizer's site says "this page or feed changed"; we mark the matching
 * feed due and the MCP Worker's feed-poll cron re-reads it (gated by
 * FEED_POLLING_ENABLED). The ping never carries data. The matching and the
 * write live in `@takemetothefair/db-schema` (feed-ping.ts), shared with the
 * WebSub callback.
 *
 * The response says nothing: `202 {"ok":true}` whatever happened, so the
 * endpoint cannot be used to learn which hosts we know. The only other
 * answers are 400 (no URL, or not an http(s) URL — a property of the request,
 * not of our data) and 429 (rate limit, applied BEFORE any lookup, to known
 * and unknown hosts alike). The lookup and write run after the response
 * (`schedule` = ctx.waitUntil), so a known host is not slower to answer either.
 *
 * Rate limits, on the BurstCounter Durable Object (a hard cap, OPE-951):
 * per pinged host 30/hour, per pinged URL 10/hour, per client IP 300/hour.
 * Without the binding (tests, `next dev`) or if it throws, the ping is
 * allowed: a ping can only move one owned feed's read earlier, and the cron
 * cadence coalesces it anyway.
 */
import {
  countPingOutcome,
  parsePingUrl,
  pingHostKey,
  pingUrlKey,
  recordChangePing,
} from "@takemetothefair/db-schema";
import type { BurstLimiter } from "@/lib/burst-limiter";
import type { getCloudflareDb } from "@/lib/cloudflare";

type Db = ReturnType<typeof getCloudflareDb>;

export const PING_LIMITS = {
  host: { max: 30, periodSeconds: 3600 },
  url: { max: 10, periodSeconds: 3600 },
  ip: { max: 300, periodSeconds: 3600 },
} as const;

const MAX_BODY_BYTES = 8 * 1024;

export interface PingDeps {
  db: Db;
  limiter: BurstLimiter | null;
  now: Date;
  /** Run work after the response (ctx.waitUntil in production). */
  schedule: (work: Promise<unknown>) => void;
  /** Called when the scheduled work throws — never shown to the caller. */
  onError?: (err: unknown) => void;
}

/** The `url` a ping names: `?url=`, else a JSON `{url}` or form `url=` body. */
export async function readPingUrl(request: Request): Promise<string | null> {
  const q = new URL(request.url).searchParams.get("url");
  if (q) return q;
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return null;
  const text = await request.text();
  if (!text || text.length > MAX_BODY_BYTES) return null;
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  if (type.includes("json") || text.trimStart().startsWith("{")) {
    try {
      const v = (JSON.parse(text) as { url?: unknown })?.url;
      return typeof v === "string" ? v : null;
    } catch {
      return null;
    }
  }
  // application/x-www-form-urlencoded (what wp_remote_post sends for an array body).
  return new URLSearchParams(text).get("url");
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Seconds to wait when any bucket refuses, or null when all allow. */
async function rateLimited(
  limiter: BurstLimiter | null,
  url: URL,
  ip: string
): Promise<number | null> {
  if (!limiter) return null;
  const checks = [
    { key: `rate:feed-ping:host:${pingHostKey(url)}`, ...PING_LIMITS.host },
    { key: `rate:feed-ping:url:${await sha256Hex(pingUrlKey(url))}`, ...PING_LIMITS.url },
    { key: `rate:feed-ping:ip:${ip}`, ...PING_LIMITS.ip },
  ];
  try {
    const verdicts = await Promise.all(checks.map((c) => limiter.limit(c)));
    const refused = verdicts.filter((v) => !v.success);
    if (refused.length === 0) return null;
    return Math.max(1, ...refused.map((v) => v.retryAfterSeconds ?? 60));
  } catch {
    return null;
  }
}

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });

/** The one fixed success body. Nothing about what the ping matched, ever. */
export const PING_ACCEPTED_BODY = { ok: true } as const;

export async function handleChangePing(request: Request, deps: PingDeps): Promise<Response> {
  const url = parsePingUrl(await readPingUrl(request).catch(() => null));
  if (!url) return json({ ok: false, error: "url is required and must be an http(s) URL" }, 400);

  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const retryAfter = await rateLimited(deps.limiter, url, ip);
  const onError = deps.onError ?? (() => undefined);
  if (retryAfter !== null) {
    deps.schedule(countPingOutcome(deps.db, "ping", "rate_limited", deps.now).catch(onError));
    return json({ ok: false, error: "rate limited" }, 429, { "Retry-After": String(retryAfter) });
  }

  deps.schedule(
    recordChangePing(deps.db, url, deps.now).catch(async (err) => {
      onError(err);
      await countPingOutcome(deps.db, "ping", "error", deps.now).catch(() => undefined);
    })
  );
  return json(PING_ACCEPTED_BODY, 202);
}
