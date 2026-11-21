/**
 * OPE-1621 — "this event page or feed changed": the change ping.
 *
 * An organizer's site tells us a page or feed changed, and we re-read it soon
 * instead of waiting for the next poll. A ping only ever TRIGGERS a read; it
 * never carries data. We fetch the source ourselves, so a forged ping cannot
 * change content — the worst it can do is make us read an owned feed early,
 * and coalescing plus the rate limit bound that.
 *
 * Two callers share this module, one per deploy artifact, so they cannot drift:
 *   - the main app's public `POST /api/v1/ping`;
 *   - the MCP Worker's WebSub callback (a verified notification is a ping).
 *
 * A ping is accepted only when BOTH hold:
 *   1. the URL's registrable domain is active, unshared and on exactly one
 *      promoter's domain list (`orgsForDomain`, OPE-1614 — a shared or
 *      free-mail domain has no owner, so it never attributes a ping);
 *   2. that promoter has an enabled `promoter_event_feeds` row whose feed URL
 *      matches the pinged URL (normalized as registration does), or failing
 *      that, whose host is the pinged URL's host.
 * Everything else is ignored and only COUNTED (`feed_ping_counts`), never
 * echoed: the caller cannot tell which hosts we know.
 *
 * Coalescing: a ping sets `next_read_at = min(existing, now + 2 min)` and
 * stamps `ping_requested_at` only if no ping is outstanding. Ten pings inside
 * the window leave one due time, so they produce one read. The read itself
 * happens in the MCP Worker's feed-poll cron, gated by FEED_POLLING_ENABLED.
 */
import { and, eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./index";
import { feedPingCounts, promoterEventFeeds } from "./index";
import { orgsForDomain } from "./org-domains";

type Db = DrizzleD1Database<typeof schema>;

/** How long a ping waits before it is due, so a burst of saves coalesces. */
export const PING_COALESCE_MS = 2 * 60_000;
/** Longest URL a ping may name. */
export const PING_URL_MAX_CHARS = 2048;
/** Most feeds one ping can mark (one promoter's feeds on one host). */
const MAX_FEEDS_PER_PING = 20;

export type PingChannel = "ping" | "websub";
export type PingOutcome =
  | "accepted"
  | "ignored_unknown_host"
  | "ignored_shared_domain"
  | "ignored_no_feed"
  | "rate_limited"
  | "error"
  // WebSub-only outcomes
  | "websub_bad_signature"
  | "websub_unknown_subscription";

/**
 * The URL a ping names, or null when it is missing or unparseable. Only
 * http(s) (webcal:// is read as https, as registration does).
 */
export function parsePingUrl(raw: unknown): URL | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().replace(/^webcals?:\/\//i, "https://");
  if (!v || v.length > PING_URL_MAX_CHARS) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (!u.hostname.includes(".")) return null;
  return u;
}

/** Hostname compared for "same host": lowercase, a leading `www.` ignored. */
export function pingHostKey(u: URL): string {
  return u.hostname.toLowerCase().replace(/^www\./, "");
}

/**
 * A comparable form of a URL: same host key, path without a trailing slash,
 * query kept, fragment and scheme dropped (an https feed pinged as http is the
 * same feed).
 */
export function pingUrlKey(u: URL): string {
  const path = u.pathname.replace(/\/+$/, "") || "/";
  return `${pingHostKey(u)}${path}${u.search}`;
}

export interface PingTarget {
  outcome: Extract<
    PingOutcome,
    "accepted" | "ignored_unknown_host" | "ignored_shared_domain" | "ignored_no_feed"
  >;
  feedIds: string[];
}

/** Which feeds (if any) a ping for this URL may mark. Reads only. */
export async function resolvePingTarget(db: Db, url: URL): Promise<PingTarget> {
  const owners = await orgsForDomain(db, "promoter", url.toString());
  if (owners.shared) return { outcome: "ignored_shared_domain", feedIds: [] };
  if (owners.ids.length !== 1) return { outcome: "ignored_unknown_host", feedIds: [] };

  const feeds = await db
    .select({ id: promoterEventFeeds.id, feedUrl: promoterEventFeeds.feedUrl })
    .from(promoterEventFeeds)
    .where(
      and(eq(promoterEventFeeds.promoterId, owners.ids[0]), eq(promoterEventFeeds.enabled, true))
    )
    .limit(200);
  const want = pingUrlKey(url);
  const host = pingHostKey(url);
  const exact: string[] = [];
  const sameHost: string[] = [];
  for (const f of feeds) {
    const fu = parsePingUrl(f.feedUrl);
    if (!fu) continue;
    if (pingUrlKey(fu) === want) exact.push(f.id);
    else if (pingHostKey(fu) === host) sameHost.push(f.id);
  }
  const ids = (exact.length > 0 ? exact : sameHost).slice(0, MAX_FEEDS_PER_PING);
  if (ids.length === 0) return { outcome: "ignored_no_feed", feedIds: [] };
  return { outcome: "accepted", feedIds: ids };
}

const secs = (d: Date) => Math.floor(d.getTime() / 1000);

/**
 * Mark feeds due because of a ping. Never reads anything: the due time only
 * moves EARLIER (`min(existing, now + 2 min)`), so repeated pings cannot push
 * a read out, and an outstanding ping keeps its original timestamp.
 */
export async function markFeedsPinged(db: Db, feedIds: string[], now: Date): Promise<void> {
  const due = secs(new Date(now.getTime() + PING_COALESCE_MS));
  const t = secs(now);
  // One small statement per feed: a ping marks at most MAX_FEEDS_PER_PING.
  for (const id of feedIds.slice(0, MAX_FEEDS_PER_PING)) {
    await db
      .update(promoterEventFeeds)
      .set({
        nextReadAt: sql`CASE WHEN ${promoterEventFeeds.nextReadAt} IS NULL OR ${promoterEventFeeds.nextReadAt} > ${due} THEN ${due} ELSE ${promoterEventFeeds.nextReadAt} END`,
        pingRequestedAt: sql`coalesce(${promoterEventFeeds.pingRequestedAt}, ${t})`,
        lastPingedAt: now,
        pingCount: sql`${promoterEventFeeds.pingCount} + 1`,
        updatedAt: now,
      })
      .where(eq(promoterEventFeeds.id, id));
  }
}

/** Count one ping/notification outcome for today (UTC). The URL is never stored. */
export async function countPingOutcome(
  db: Db,
  channel: PingChannel,
  outcome: PingOutcome,
  now: Date
): Promise<void> {
  await db
    .insert(feedPingCounts)
    .values({ day: now.toISOString().slice(0, 10), channel, outcome, count: 1, updatedAt: now })
    .onConflictDoUpdate({
      target: [feedPingCounts.day, feedPingCounts.channel, feedPingCounts.outcome],
      set: { count: sql`${feedPingCounts.count} + 1`, updatedAt: now },
    });
}

/**
 * The whole ping, after the caller has parsed the URL and passed the rate
 * limit: resolve, mark when accepted, count either way. Returns the outcome
 * for tests and logs — a public caller must NOT pass it on.
 */
export async function recordChangePing(
  db: Db,
  url: URL,
  now: Date
): Promise<PingTarget["outcome"]> {
  const target = await resolvePingTarget(db, url);
  if (target.outcome === "accepted") await markFeedsPinged(db, target.feedIds, now);
  await countPingOutcome(db, "ping", target.outcome, now);
  return target.outcome;
}
