/**
 * OPE-1625 — "Check my calendar": a pasted calendar URL → the events we would
 * pick up, the ones we would skip and why, and the problems. Writes nothing:
 * not an event, not a feed row, not a log row (failures go to the Worker log
 * only). The per-IP limit lives in the BurstCounter Durable Object, not in D1.
 */
import type { getCloudflareDb } from "@/lib/cloudflare";
import { getBurstLimiter } from "@/lib/burst-limiter";
import { isDeployedEnvironment } from "@/lib/runtime-env";
import { assessFeedItem, countOutcomes, SOURCE_FOR_KIND } from "./engine";
import { readCalendarUrl, type CalendarDeps } from "./fetch-calendar";
import { assertReadOnly } from "./read-only-db";
import type { CalendarCheckReport, ItemReport } from "./types";

type Db = ReturnType<typeof getCloudflareDb>;

/** Each check fetches someone else's server, so the cap is per hour, per IP. */
export const CHECK_CALENDAR_RATE = { max: 20, periodSeconds: 3600 } as const;
/** OPE-1625 phase 2 — /api/v1/preview-event fetches nothing outside our own
 *  database, so its cap is looser than check-calendar's. Here, not in the route
 *  file: Next.js refuses a non-handler export from route.ts. */
export const PREVIEW_EVENT_RATE = { max: 60, periodSeconds: 3600 } as const;
/** Items listed in one report; the counts still cover everything read. */
export const CHECK_MAX_ITEMS = 200;

export async function checkCalendar(
  db: Db,
  url: string,
  opts: { now: Date; deps?: CalendarDeps }
): Promise<CalendarCheckReport> {
  assertReadOnly(db);
  const read = await readCalendarUrl(url, opts);
  const source = SOURCE_FOR_KIND[read.kind];
  const items: ItemReport[] = [];
  for (const ev of read.items.slice(0, CHECK_MAX_ITEMS))
    items.push(await assessFeedItem(db, ev, { now: opts.now, source }));
  const truncated = read.items.length > CHECK_MAX_ITEMS;
  const notes = [...read.notes];
  if (truncated)
    notes.push(`We read ${read.items.length} events and list the first ${CHECK_MAX_ITEMS}.`);
  return {
    dry_run: true,
    source: {
      url,
      final_url: read.finalUrl,
      kind: read.kind,
      calendar_name: read.calendarName,
      pages_read: read.pagesRead,
    },
    window: read.window,
    counts: countOutcomes(items),
    notes,
    truncated,
    items,
  };
}

/** The visitor's IP as Cloudflare saw it. */
export function clientIp(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

/**
 * The per-IP cap. FAILS CLOSED, unlike the promoter API's limiter: this route
 * makes our Worker fetch an arbitrary public URL, and an uncapped public
 * fetcher is the abuse this limit exists for. No binding in a deployed Worker,
 * or a limiter that throws → refused (503). No binding locally / in unit tests → allowed.
 */
export async function checkCalendarRateLimit(ip: string): Promise<RateVerdict> {
  return publicRateLimit("check-calendar", CHECK_CALENDAR_RATE, ip);
}

export type RateVerdict =
  { allowed: true } | { allowed: false; status: 429 | 503; retryAfterSeconds: number };

/**
 * OPE-1625 — the fail-closed per-IP cap shared by the public test-submission
 * routes (check-calendar, preview-event). `scope` keys the BurstCounter, so
 * one route's use never spends another's allowance.
 */
export async function publicRateLimit(
  scope: string,
  rate: { max: number; periodSeconds: number },
  ip: string
): Promise<RateVerdict> {
  const limiter = getBurstLimiter();
  if (!limiter) {
    if (isDeployedEnvironment()) {
      console.error(`[${scope}] BURST_COUNTER binding missing in production — refusing`);
      return { allowed: false, status: 503, retryAfterSeconds: 60 };
    }
    return { allowed: true };
  }
  try {
    const v = await limiter.limit({
      key: `${scope}:${ip}`,
      max: rate.max,
      periodSeconds: rate.periodSeconds,
    });
    if (v.success) return { allowed: true };
    return {
      allowed: false,
      status: 429,
      retryAfterSeconds: Math.min(
        rate.periodSeconds,
        Math.max(1, v.retryAfterSeconds ?? rate.periodSeconds)
      ),
    };
  } catch (error) {
    console.error(`[${scope}] burst limiter threw; refusing`, error);
    return { allowed: false, status: 503, retryAfterSeconds: 60 };
  }
}
