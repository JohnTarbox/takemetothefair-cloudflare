/**
 * A9 (2026-06-26) — edge request sampling to identify the recurring
 * 21st-of-month bot inflating GA4.
 *
 * The zone is on the FREE plan, so Cloudflare Logpush (the only CF-native
 * raw-User-Agent capture) is unavailable — it's Enterprise-only. Instead,
 * src/middleware.ts samples a small slice of public page requests at the edge
 * and records UA + IP + ASN + path here. The write is fire-and-forget via
 * ctx.waitUntil so it never blocks the response, and this module never throws —
 * sampling is best-effort observability.
 *
 * Read back the spike window (≈ the 21st) via GET /api/admin/request-samples,
 * which groups by (asn, as_organization, user_agent) so the high-volume bot
 * fingerprint stands out for a WAF Managed-Challenge rule + GA4 filter.
 */
import { lt } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { requestSamples } from "@/lib/db/schema";

/** Fraction of eligible requests captured. The bot is high-volume on the 21st
 *  (~11k requests on a fixed page set), so 5% still yields hundreds of bot rows
 *  while keeping normal-traffic writes modest on this low-traffic Free zone. */
export const REQUEST_SAMPLE_RATE = 0.05;
const RETENTION_DAYS = 60;
const PRUNE_PROBABILITY = 0.01;

/** Pure sampling gate — `rand` injected so the decision is testable. */
export function shouldSample(rand: number): boolean {
  return rand < REQUEST_SAMPLE_RATE;
}

export interface RequestSampleInput {
  path?: string | null;
  method?: string | null;
  userAgent?: string | null;
  ip?: string | null;
  asn?: number | null;
  asOrganization?: string | null;
  country?: string | null;
  referer?: string | null;
  ray?: string | null;
}

/**
 * Insert one sampled request and, on ~1% of calls, prune rows older than the
 * retention window (mirrors the error_logs cleanup pattern — keeps the table
 * bounded without a dedicated cron). Never throws.
 */
export async function writeRequestSample(
  db: Database,
  input: RequestSampleInput,
  opts: { now?: Date; pruneRoll?: number } = {}
): Promise<void> {
  const now = opts.now ?? new Date();
  try {
    await db.insert(requestSamples).values({
      timestamp: now,
      path: input.path ?? null,
      method: input.method ?? null,
      userAgent: input.userAgent ?? null,
      ip: input.ip ?? null,
      asn: input.asn ?? null,
      asOrganization: input.asOrganization ?? null,
      country: input.country ?? null,
      referer: input.referer ?? null,
      ray: input.ray ?? null,
    });

    const roll = opts.pruneRoll ?? Math.random();
    if (roll < PRUNE_PROBABILITY) {
      const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86400 * 1000);
      await db.delete(requestSamples).where(lt(requestSamples.timestamp, cutoff));
    }
  } catch {
    // best-effort — must never surface to the request path.
  }
}
