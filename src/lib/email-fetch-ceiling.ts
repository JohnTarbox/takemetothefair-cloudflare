/**
 * OPE-1412 — the GLOBAL daily ceiling on email-driven URL fetches.
 *
 * OPE-1370 (SSRF8) moved inbound-email fetches onto PER-SENDER buckets
 * (`import-url-fetch`, 60/hour, keyed `sender:<sha256 prefix>`). That stopped
 * one sender starving the rest, but left no total: a stream that rotates its
 * From address gets a fresh bucket per address. This is the total.
 *
 *   - Counted with the SAME mechanism as the per-sender bucket (`checkRateLimit`,
 *     metered → KV, fail-closed), under one key per UTC day
 *     (`rate:import-url-fetch-email-daily:global:YYYY-MM-DD`), so it resets at
 *     UTC midnight by construction.
 *   - Checked only AFTER the per-sender bucket allowed the call, so a sender
 *     already over its own limit never spends a global slot.
 *   - A refusal is answered exactly like a per-sender refusal (429), which the
 *     MCP Worker's `submitFetch` turns into `fetch-429` — the existing failed
 *     -fetch path: the email is still processed (body-prose fallback, then the
 *     same reply a failed fetch gets). Nothing here touches the reply.
 *   - Visible: at most ONE `logError` per UTC hour, carrying the count of
 *     fetches skipped so far today, deduped by a KV marker.
 */
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { logError } from "@/lib/logger";
import { checkRateLimit, EMAIL_FETCH_DAILY_CEILING, type RateLimitResult } from "@/lib/rate-limit";

export const EMAIL_FETCH_CEILING_ENDPOINT = "import-url-fetch-email-daily" as const;
const LOG_SOURCE = "api/admin/import-url/fetch:email-daily-ceiling";

/** `YYYY-MM-DD` of `nowMs` in UTC. */
export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** `YYYY-MM-DDTHH` of `nowMs` in UTC — the log-dedupe bucket. */
function utcHour(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 13);
}

function nextUtcMidnightSeconds(nowMs: number): number {
  const d = new Date(nowMs);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) / 1000);
}

function getKv(): KVNamespace | null {
  try {
    const { env } = getCloudflareContext();
    return (env as { RATE_LIMIT_KV?: KVNamespace }).RATE_LIMIT_KV ?? null;
  } catch {
    return null;
  }
}

/** Is this metered caller an email-driven (per-sender) fetch? */
export function isEmailDrivenCaller(meteredIdentifier: string): boolean {
  return meteredIdentifier.startsWith("sender:");
}

/**
 * Count one email-driven fetch against today's global ceiling. Returns the
 * verdict; on a refusal it also records the skip and logs (≤ once per hour).
 * Never throws: the logging half is best-effort, the counting half is
 * `checkRateLimit`'s fail-closed metered path.
 */
export async function checkEmailFetchDailyCeiling(
  request: Request,
  db: DrizzleD1Database<Record<string, unknown>> | null
): Promise<RateLimitResult> {
  const now = Date.now();
  const day = utcDay(now);
  const verdict = await checkRateLimit(request, EMAIL_FETCH_CEILING_ENDPOINT, {
    metered: { identifier: `global:${day}` },
  });
  // The bucket is per UTC day: Retry-After must point at midnight, not at the
  // oldest timestamp + 24h the sliding window would compute.
  const result: RateLimitResult = { ...verdict, resetAt: nextUtcMidnightSeconds(now) };
  if (!result.allowed) await recordSkip(db, now, day);
  return result;
}

async function recordSkip(
  db: DrizzleD1Database<Record<string, unknown>> | null,
  now: number,
  day: string
): Promise<void> {
  const kv = getKv();
  let skippedToday: number | null = null;
  let alreadyLoggedThisHour = false;
  if (kv) {
    try {
      const skippedKey = `rate:${EMAIL_FETCH_CEILING_ENDPOINT}:skipped:${day}`;
      skippedToday = Number((await kv.get(skippedKey)) ?? "0") + 1;
      await kv.put(skippedKey, String(skippedToday), { expirationTtl: 2 * 24 * 60 * 60 });

      const loggedKey = `rate:${EMAIL_FETCH_CEILING_ENDPOINT}:logged:${utcHour(now)}`;
      alreadyLoggedThisHour = (await kv.get(loggedKey)) !== null;
      if (!alreadyLoggedThisHour) {
        await kv.put(loggedKey, "1", { expirationTtl: 2 * 60 * 60 });
      }
    } catch (error) {
      // A KV fault here must not change the verdict; fall through and log
      // (without the dedupe) so the refusal is still visible.
      console.error("[email-fetch-ceiling] KV error recording a skip:", error);
    }
  }
  if (alreadyLoggedThisHour) return;
  try {
    await logError(db, {
      level: "warn",
      message:
        `Email-driven URL fetch skipped: global daily ceiling of ${EMAIL_FETCH_DAILY_CEILING} reached ` +
        `(${skippedToday ?? "?"} skipped so far on ${day} UTC). Emails are still processed as a failed fetch.`,
      source: LOG_SOURCE,
      context: {
        ceiling: EMAIL_FETCH_DAILY_CEILING,
        day,
        skippedToday,
      },
    });
  } catch {
    // logError is itself best-effort; never let it change the response.
  }
}
