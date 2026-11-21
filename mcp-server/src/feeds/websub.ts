/**
 * OPE-1621 — WebSub subscriber for organizer feeds.
 *
 * When a feed read sees a hub (`Link: <…>; rel="hub"` header, or a
 * `<link rel="hub">` / `<atom:link rel="hub">` in the body), we subscribe to
 * it, and the hub then POSTs us a notification whenever the topic changes.
 * A notification is treated EXACTLY like a change ping: its signature is
 * checked, the feed is marked due, and its body is never parsed — we re-read
 * the source ourselves, so a hub (or anyone) cannot put content in our data.
 *
 * Lives in the MCP Worker, callback included (`/websub/callback/<id>` on
 * mcp.meetmeatthefair.com), because the whole lifecycle is here: discovery
 * happens inside a feed read, subscribing and lease renewal run in the
 * feed-poll cron, and the stored secret never has to leave this Worker. The
 * main app has nothing to add but a second copy of the secret handling.
 *
 * GATED (OPE-1626): subscribing and renewing POST to a third-party hub, so
 * they need BOTH `FEED_POLLING_ENABLED` and `WEBSUB_ENABLED` = "true". The two
 * functions that send (`ensureWebSubSubscription`, `renewWebSubLeases`) check
 * the flags themselves, not only their caller, so a new call site cannot
 * subscribe by forgetting the gate. The callback answers regardless (it only
 * ever confirms a subscription we asked for, and a notification only marks a
 * feed due — the read is gated by FEED_POLLING_ENABLED).
 */
import { and, eq, isNotNull, lte, or } from "drizzle-orm";
import {
  countPingOutcome,
  feedWebsubSubscriptions,
  markFeedsPinged,
  promoterEventFeeds,
} from "../schema.js";
import type { Db } from "../db.js";
import { FEED_USER_AGENT } from "./fetch-feed.js";

export const WEBSUB_CALLBACK_BASE = "https://mcp.meetmeatthefair.com/websub/callback/";
export const WEBSUB_CALLBACK_PATH = "/websub/callback/";
/** What we ask for; the hub decides and tells us in the intent check. */
export const WEBSUB_LEASE_SECONDS = 10 * 86_400;
/** Renew this long before the lease runs out. */
const RENEW_BEFORE_MS = 86_400_000;
/** A request the hub never confirmed (or refused) is retried after this. */
const RETRY_PENDING_AFTER_MS = 86_400_000;
/** Notifications larger than this are ignored unhashed. */
const MAX_NOTIFY_BYTES = 1024 * 1024;
const BODY_SCAN_CHARS = 200_000;

/** The two flags WebSub needs. */
export interface WebSubFlags {
  FEED_POLLING_ENABLED?: string;
  WEBSUB_ENABLED?: string;
}

/** OPE-1626 — subscribing/renewing is allowed only with polling AND WebSub on. */
export function isWebSubEnabled(env: WebSubFlags | undefined | null): boolean {
  return env?.FEED_POLLING_ENABLED === "true" && env?.WEBSUB_ENABLED === "true";
}

export interface HubLinks {
  hub: string;
  topic: string;
}

function httpUrl(v: string | undefined | null, base?: string): string | null {
  if (!v) return null;
  try {
    const u = new URL(v.trim(), base);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** `Link` header → [{url, rels}]. Tolerates several values and quoted rels. */
export function parseLinkHeader(h: string | null): Array<{ url: string; rels: string[] }> {
  if (!h) return [];
  const out: Array<{ url: string; rels: string[] }> = [];
  for (const m of h.matchAll(/<([^>]*)>([^,<]*)/g)) {
    const rel = /;\s*rel\s*=\s*(?:"([^"]*)"|([^\s;,]+))/i.exec(m[2]);
    const rels = (rel?.[1] ?? rel?.[2] ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    out.push({ url: m[1], rels });
  }
  return out;
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
}

/**
 * The hub and topic a read advertised, or null. The header wins over the body
 * (WebSub §4). The topic is the advertised `rel="self"`, else the feed URL.
 * Only an https hub is used: we POST a secret to it.
 */
export function discoverHub(args: {
  body: string | null;
  linkHeader: string | null;
  feedUrl: string;
}): HubLinks | null {
  let hub: string | null = null;
  let self: string | null = null;
  for (const l of parseLinkHeader(args.linkHeader)) {
    if (!hub && l.rels.includes("hub")) hub = httpUrl(l.url, args.feedUrl);
    if (!self && l.rels.includes("self")) self = httpUrl(l.url, args.feedUrl);
  }
  if (!hub && args.body) {
    const head = args.body.slice(0, BODY_SCAN_CHARS);
    for (const m of head.matchAll(/<(?:atom:)?link\b[^>]*>/gi)) {
      const rels = (attr(m[0], "rel") ?? "").toLowerCase().split(/\s+/);
      const href = attr(m[0], "href");
      if (!hub && rels.includes("hub")) hub = httpUrl(href, args.feedUrl);
      if (!self && rels.includes("self")) self = httpUrl(href, args.feedUrl);
    }
  }
  if (!hub || !hub.startsWith("https:")) return null;
  return { hub, topic: self ?? args.feedUrl };
}

const HMAC_ALGOS: Record<string, string> = {
  sha1: "SHA-1",
  sha256: "SHA-256",
  sha384: "SHA-384",
  sha512: "SHA-512",
};

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * `X-Hub-Signature: <method>=<hex>` over the raw body, keyed by the secret we
 * gave the hub (WebSub §8). sha1/sha256/sha384/sha512. Constant-time compare.
 */
export async function verifyHubSignature(
  secret: string,
  header: string | null,
  body: ArrayBuffer
): Promise<boolean> {
  if (!header) return false;
  const eq = header.indexOf("=");
  if (eq < 1) return false;
  const algo = HMAC_ALGOS[header.slice(0, eq).trim().toLowerCase()];
  const given = header
    .slice(eq + 1)
    .trim()
    .toLowerCase();
  if (!algo || !/^[0-9a-f]+$/.test(given)) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: algo },
    false,
    ["sign"]
  );
  const want = toHex(await crypto.subtle.sign("HMAC", key, body));
  if (want.length !== given.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

function newSecret(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

type SubRow = typeof feedWebsubSubscriptions.$inferSelect;

/** POST the subscribe request. The row is marked pending FIRST, so a hub that verifies synchronously finds it. */
async function sendSubscribe(
  db: Db,
  sub: SubRow,
  now: Date,
  fetchImpl: typeof fetch
): Promise<"subscribed" | "error"> {
  await db
    .update(feedWebsubSubscriptions)
    .set({ pendingMode: "subscribe", requestedAt: now, updatedAt: now })
    .where(eq(feedWebsubSubscriptions.id, sub.id));
  let error: string | null = null;
  try {
    const res = await fetchImpl(sub.hubUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": FEED_USER_AGENT,
      },
      body: new URLSearchParams({
        "hub.mode": "subscribe",
        "hub.topic": sub.topicUrl,
        "hub.callback": `${WEBSUB_CALLBACK_BASE}${sub.id}`,
        "hub.secret": sub.secret,
        "hub.lease_seconds": String(WEBSUB_LEASE_SECONDS),
      }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) error = `hub answered HTTP ${res.status}`;
  } catch (e) {
    error = `hub request failed: ${(e as Error).message}`.slice(0, 300);
  }
  await db
    .update(feedWebsubSubscriptions)
    .set({ lastError: error, updatedAt: now })
    .where(eq(feedWebsubSubscriptions.id, sub.id));
  return error ? "error" : "subscribed";
}

/**
 * Make sure a feed that advertised this hub+topic has a live subscription:
 * subscribe when there is none, renew when the lease is near its end, retry a
 * request the hub never confirmed after a day. Otherwise no-op.
 */
export async function ensureWebSubSubscription(
  db: Db,
  args: {
    feedId: string;
    links: HubLinks;
    now: Date;
    fetchImpl?: typeof fetch;
    /** OPE-1626 — both flags; anything else writes and sends nothing. */
    flags: WebSubFlags;
  }
): Promise<"subscribed" | "current" | "error" | "disabled"> {
  if (!isWebSubEnabled(args.flags)) return "disabled";
  const t = args.now.getTime();
  let [sub] = await db
    .select()
    .from(feedWebsubSubscriptions)
    .where(
      and(
        eq(feedWebsubSubscriptions.feedId, args.feedId),
        eq(feedWebsubSubscriptions.hubUrl, args.links.hub),
        eq(feedWebsubSubscriptions.topicUrl, args.links.topic)
      )
    )
    .limit(1);
  if (sub) {
    const requested = sub.requestedAt?.getTime() ?? 0;
    if ((sub.pendingMode || sub.state === "denied") && t - requested < RETRY_PENDING_AFTER_MS)
      return "current";
    if (
      sub.state === "active" &&
      !sub.pendingMode &&
      (sub.leaseExpiresAt?.getTime() ?? 0) - t > RENEW_BEFORE_MS
    )
      return "current";
  } else {
    [sub] = await db
      .insert(feedWebsubSubscriptions)
      .values({
        feedId: args.feedId,
        hubUrl: args.links.hub,
        topicUrl: args.links.topic,
        secret: newSecret(),
        state: "pending",
        createdAt: args.now,
        updatedAt: args.now,
      })
      .returning();
  }
  return sendSubscribe(db, sub, args.now, args.fetchImpl ?? fetch);
}

/** Renew leases ending within a day, and retry unconfirmed requests older than a day. */
export async function renewWebSubLeases(
  db: Db,
  args: {
    now: Date;
    limit?: number;
    fetchImpl?: typeof fetch;
    /** OPE-1626 — both flags; anything else renews nothing. */
    flags: WebSubFlags;
  }
): Promise<{ renewed: number; errors: number }> {
  if (!isWebSubEnabled(args.flags)) return { renewed: 0, errors: 0 };
  const t = args.now.getTime();
  const rows = await db
    .select({ sub: feedWebsubSubscriptions })
    .from(feedWebsubSubscriptions)
    .innerJoin(promoterEventFeeds, eq(promoterEventFeeds.id, feedWebsubSubscriptions.feedId))
    .where(
      and(
        eq(promoterEventFeeds.enabled, true),
        or(
          and(
            eq(feedWebsubSubscriptions.state, "active"),
            lte(feedWebsubSubscriptions.leaseExpiresAt, new Date(t + RENEW_BEFORE_MS))
          ),
          and(
            isNotNull(feedWebsubSubscriptions.pendingMode),
            lte(feedWebsubSubscriptions.requestedAt, new Date(t - RETRY_PENDING_AFTER_MS))
          )
        )
      )
    )
    .limit(args.limit ?? 10);
  let renewed = 0;
  let errors = 0;
  for (const { sub } of rows) {
    const r = await sendSubscribe(db, sub, args.now, args.fetchImpl ?? fetch);
    if (r === "subscribed") renewed++;
    else errors++;
  }
  return { renewed, errors };
}

const notFound = () => new Response("not found", { status: 404 });
const accepted = () => new Response(null, { status: 202 });
const ID_RE = /^[0-9a-f-]{36}$/i;

/**
 * `GET|POST /websub/callback/<subscription id>`.
 *
 * GET — the hub's intent check. `hub.challenge` is echoed ONLY when the mode
 * and topic match a request we have pending for that subscription; anything
 * else is a 404 (WebSub §5.3). `hub.mode=denied` for our topic records the
 * refusal.
 *
 * POST — a content notification. Always 202 (a hub must not learn whether a
 * signature passed, §8). Marks the feed due only for an ACTIVE subscription
 * with a valid `X-Hub-Signature`; the body is hashed, never parsed.
 */
export async function handleWebSubCallback(
  request: Request,
  db: Db,
  now: Date = new Date()
): Promise<Response> {
  const url = new URL(request.url);
  const id = url.pathname.slice(WEBSUB_CALLBACK_PATH.length);
  if (request.method === "GET") {
    if (!ID_RE.test(id)) return notFound();
    const [sub] = await db
      .select()
      .from(feedWebsubSubscriptions)
      .where(eq(feedWebsubSubscriptions.id, id))
      .limit(1);
    const mode = url.searchParams.get("hub.mode");
    const topic = url.searchParams.get("hub.topic");
    if (!sub || topic !== sub.topicUrl) return notFound();
    if (mode === "denied") {
      await db
        .update(feedWebsubSubscriptions)
        .set({
          state: "denied",
          pendingMode: null,
          lastError: `denied: ${url.searchParams.get("hub.reason") ?? "no reason given"}`.slice(
            0,
            300
          ),
          updatedAt: now,
        })
        .where(eq(feedWebsubSubscriptions.id, sub.id));
      return new Response("", { status: 200 });
    }
    const challenge = url.searchParams.get("hub.challenge");
    if (mode !== "subscribe" || sub.pendingMode !== "subscribe" || !challenge) return notFound();
    const askedLease = Number(url.searchParams.get("hub.lease_seconds"));
    const lease =
      Number.isInteger(askedLease) && askedLease > 0 ? askedLease : WEBSUB_LEASE_SECONDS;
    await db
      .update(feedWebsubSubscriptions)
      .set({
        state: "active",
        pendingMode: null,
        verifiedAt: now,
        leaseSeconds: lease,
        leaseExpiresAt: new Date(now.getTime() + lease * 1000),
        lastError: null,
        updatedAt: now,
      })
      .where(eq(feedWebsubSubscriptions.id, sub.id));
    return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
  }

  if (request.method === "POST") {
    const declared = Number(request.headers.get("content-length") ?? 0);
    const sub = ID_RE.test(id)
      ? (
          await db
            .select()
            .from(feedWebsubSubscriptions)
            .where(eq(feedWebsubSubscriptions.id, id))
            .limit(1)
        )[0]
      : undefined;
    if (!sub || sub.state !== "active") {
      await countPingOutcome(db, "websub", "websub_unknown_subscription", now);
      return accepted();
    }
    const body = declared > MAX_NOTIFY_BYTES ? null : await request.arrayBuffer();
    const ok =
      body !== null &&
      body.byteLength <= MAX_NOTIFY_BYTES &&
      (await verifyHubSignature(sub.secret, request.headers.get("x-hub-signature"), body));
    if (!ok) {
      await countPingOutcome(db, "websub", "websub_bad_signature", now);
      return accepted();
    }
    // The body proved who sent it; WHAT it says is ignored. Mark due, re-read ourselves.
    await markFeedsPinged(db, [sub.feedId], now);
    await db
      .update(feedWebsubSubscriptions)
      .set({ lastNotifiedAt: now, notifyCount: sub.notifyCount + 1, updatedAt: now })
      .where(eq(feedWebsubSubscriptions.id, sub.id));
    await countPingOutcome(db, "websub", "accepted", now);
    return accepted();
  }

  return new Response("method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
}
