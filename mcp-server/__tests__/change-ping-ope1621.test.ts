/**
 * OPE-1621 — change pings and the WebSub subscriber, against the real 0406 +
 * 0409 + 0412 DDL (setup-db loads them from the migration files).
 *
 * Nothing touches the network: every fetch is a fake that records its calls.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb, type TestDb } from "./setup-db.js";
import {
  PING_COALESCE_MS,
  parsePingUrl,
  recordChangePing,
  resolvePingTarget,
} from "@takemetothefair/db-schema";
import { pollDueFeeds } from "../src/feeds/schedule.js";
import {
  WEBSUB_CALLBACK_BASE,
  discoverHub,
  ensureWebSubSubscription,
  handleWebSubCallback,
  parseLinkHeader,
  renewWebSubLeases,
  verifyHubSignature,
} from "../src/feeds/websub.js";

let db: TestDb;
let raw: Database.Database;
const T0 = new Date("2026-11-10T15:00:00Z");
const secs = (d: Date) => Math.floor(d.getTime() / 1000);
const FEED_URL = "https://www.examplefair.org/?ical=1";
const PAGE_URL = "https://examplefair.org/event/harvest-festival/";
const ICS = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nEND:VCALENDAR\r\n";

function promoter(id: string, website: string | null) {
  raw
    .prepare("INSERT INTO promoters (id, company_name, slug, website) VALUES (?, ?, ?, ?)")
    .run(id, `Promoter ${id}`, `promoter-${id}`, website);
}
function feed(id: string, promoterId: string, url: string, nextReadAt: Date | null = null) {
  raw
    .prepare(
      `INSERT INTO promoter_event_feeds (id, promoter_id, feed_url, kind, enabled, next_read_at, created_at, updated_at)
       VALUES (?, ?, ?, 'ical', 1, ?, ?, ?)`
    )
    .run(id, promoterId, url, nextReadAt ? secs(nextReadAt) : null, secs(T0), secs(T0));
}
type FeedRow = {
  next_read_at: number | null;
  ping_requested_at: number | null;
  last_pinged_at: number | null;
  ping_count: number;
  last_read_at: number | null;
};
const feedRow = (id: string) =>
  raw
    .prepare(
      "SELECT next_read_at, ping_requested_at, last_pinged_at, ping_count, last_read_at FROM promoter_event_feeds WHERE id = ?"
    )
    .get(id) as FeedRow;
const counts = () =>
  raw
    .prepare("SELECT channel, outcome, count FROM feed_ping_counts ORDER BY channel, outcome")
    .all() as Array<{ channel: string; outcome: string; count: number }>;
const subs = () =>
  raw.prepare("SELECT * FROM feed_websub_subscriptions").all() as Array<Record<string, unknown>>;

function fakeFetch(
  respond: (url: string, init?: RequestInit) => Response = () => new Response(ICS)
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (u: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(u), init });
    return respond(String(u), init);
  }) as typeof fetch;
  return { impl, calls };
}

// A far-future next read, so only a ping makes the feed due.
const LATER = new Date(T0.getTime() + 6 * 3_600_000);
const url = (s: string) => {
  const u = parsePingUrl(s);
  if (!u) throw new Error(`unparseable test url ${s}`);
  return u;
};

beforeEach(() => {
  ({ db, raw } = createTestDb());
  promoter("p1", "https://www.examplefair.org");
  feed("f1", "p1", FEED_URL, LATER);
});

describe("change ping — who may ping", () => {
  it("a page on the promoter's own domain marks its feed due, two minutes out", async () => {
    // positive landmark: the feed starts NOT due (6h out) and unpinged
    expect(feedRow("f1")).toMatchObject({ next_read_at: secs(LATER), ping_requested_at: null });
    expect(await recordChangePing(db as never, url(PAGE_URL), T0)).toBe("accepted");
    const r = feedRow("f1");
    expect(r.next_read_at).toBe(secs(T0) + PING_COALESCE_MS / 1000);
    expect(r.ping_requested_at).toBe(secs(T0));
    expect(r.ping_count).toBe(1);
    expect(counts()).toEqual([{ channel: "ping", outcome: "accepted", count: 1 }]);
  });

  it("the feed URL itself matches exactly, scheme / www / trailing slash aside", async () => {
    promoter("p9", "https://other.org");
    feed("f9", "p9", "https://other.org/calendar.ics", LATER);
    feed("f10", "p9", "https://other.org/feed/events/", LATER);
    const t = await resolvePingTarget(db as never, url("http://www.other.org/feed/events"));
    // exact match wins over the same-host feed
    expect(t).toEqual({ outcome: "accepted", feedIds: ["f10"] });
  });

  it("unknown host, shared domain, non-ownable host and a host with no feed all do nothing", async () => {
    // shared: two promoters' websites both name sharedfair.org
    promoter("p2", "https://sharedfair.org");
    promoter("p3", "https://www.sharedfair.org/about");
    feed("f2", "p2", "https://sharedfair.org/?ical=1", LATER);
    // operator-listed umbrella domain, with a feed
    promoter("p4", "https://umbrella.org/fair");
    feed("f4", "p4", "https://umbrella.org/?ical=1", LATER);
    raw
      .prepare(
        "INSERT INTO shared_org_domains (domain, note, added_by, created_at) VALUES ('umbrella.org', 'test', 'test', ?)"
      )
      .run(secs(T0));
    // on a promoter's list, but no feed registered
    promoter("p5", "https://nofeed.org");

    const outcomes: Record<string, string> = {};
    for (const u of [
      "https://stranger.org/event/x",
      "https://sharedfair.org/event/x",
      "https://umbrella.org/event/x",
      "https://calendar.google.com/calendar/ical/x/basic.ics",
      "https://nofeed.org/event/x",
    ])
      outcomes[u] = await recordChangePing(db as never, url(u), T0);
    expect(outcomes).toEqual({
      "https://stranger.org/event/x": "ignored_unknown_host",
      "https://sharedfair.org/event/x": "ignored_shared_domain",
      "https://umbrella.org/event/x": "ignored_shared_domain",
      "https://calendar.google.com/calendar/ical/x/basic.ics": "ignored_unknown_host",
      "https://nofeed.org/event/x": "ignored_no_feed",
    });
    // nothing was marked — every feed still 6h out, unpinged
    for (const id of ["f1", "f2", "f4"])
      expect(feedRow(id)).toMatchObject({ next_read_at: secs(LATER), ping_requested_at: null });
    // ignored pings are counted, never stored with their URL
    expect(counts()).toEqual([
      { channel: "ping", outcome: "ignored_no_feed", count: 1 },
      { channel: "ping", outcome: "ignored_shared_domain", count: 2 },
      { channel: "ping", outcome: "ignored_unknown_host", count: 2 },
    ]);
    expect(JSON.stringify(raw.prepare("SELECT * FROM feed_ping_counts").all())).not.toMatch(
      /stranger|sharedfair|umbrella|nofeed/
    );
  });

  it("a candidate (unconfirmed) domain is not on the active list", async () => {
    promoter("p6", null);
    raw
      .prepare(
        `INSERT INTO org_domains (id, entity_type, entity_id, domain, status, method, added_by, created_at, updated_at)
         VALUES ('d1', 'promoter', 'p6', 'candidatefair.org', 'candidate', 'contact_claim', 'test', ?, ?)`
      )
      .run(secs(T0), secs(T0));
    feed("f6", "p6", "https://candidatefair.org/?ical=1", LATER);
    expect(await recordChangePing(db as never, url("https://candidatefair.org/e"), T0)).toBe(
      "ignored_unknown_host"
    );
    expect(feedRow("f6").ping_requested_at).toBeNull();
  });
});

describe("change ping — coalescing and the read", () => {
  it("ten pings in a few minutes produce ONE read; the ping is then served", async () => {
    for (let i = 0; i < 10; i++)
      await recordChangePing(db as never, url(PAGE_URL), new Date(T0.getTime() + i * 15_000));
    const r = feedRow("f1");
    // the due time never moved later than the FIRST ping + 2 min
    expect(r.next_read_at).toBe(secs(T0) + 120);
    expect(r.ping_requested_at).toBe(secs(T0));
    expect(r.ping_count).toBe(10);

    const web = fakeFetch();
    const at = new Date(T0.getTime() + 10 * 60_000);
    const s1 = await pollDueFeeds(db as never, {
      now: at,
      enabled: true,
      onlyPinged: true,
      fetchImpl: web.impl,
    });
    expect(s1).toMatchObject({ due: 1, ingested: 1, errors: 0, feed_ids: ["f1"] });
    expect(web.calls.map((c) => c.url)).toEqual([FEED_URL]);
    const after = feedRow("f1");
    expect(after.ping_requested_at).toBeNull();
    expect(after.next_read_at).toBe(secs(at) + 6 * 3600);

    const s2 = await pollDueFeeds(db as never, {
      now: new Date(at.getTime() + 10 * 60_000),
      enabled: true,
      onlyPinged: true,
      fetchImpl: web.impl,
    });
    expect(s2.due).toBe(0);
    expect(web.calls).toHaveLength(1);
  });

  it("with FEED_POLLING_ENABLED off, pings are recorded and coalesced but nothing is read", async () => {
    for (let i = 0; i < 3; i++) await recordChangePing(db as never, url(PAGE_URL), T0);
    const web = fakeFetch(() => {
      throw new Error("must not fetch");
    });
    const off = await pollDueFeeds(db as never, {
      now: new Date(T0.getTime() + 10 * 60_000),
      enabled: false,
      onlyPinged: true,
      fetchImpl: web.impl,
    });
    expect(off).toMatchObject({ enabled: false, due: 0, ingested: 0 });
    expect(web.calls).toHaveLength(0);
    expect(feedRow("f1")).toMatchObject({
      ping_count: 3,
      ping_requested_at: secs(T0),
      last_read_at: null,
    });
  });

  it("the pinged pass skips a feed that is due but was not pinged", async () => {
    feed("f7", "p1", "https://examplefair.org/other.ics", T0);
    const web = fakeFetch();
    const s = await pollDueFeeds(db as never, {
      now: T0,
      enabled: true,
      onlyPinged: true,
      fetchImpl: web.impl,
    });
    expect(s.due).toBe(0);
  });

  it("an erroring pinged feed is served once, then keeps its backoff", async () => {
    await recordChangePing(db as never, url(PAGE_URL), T0);
    const web = fakeFetch(() => new Response("down", { status: 503 }));
    const at = new Date(T0.getTime() + 5 * 60_000);
    const s = await pollDueFeeds(db as never, {
      now: at,
      enabled: true,
      onlyPinged: true,
      fetchImpl: web.impl,
    });
    expect(s).toMatchObject({ due: 1, errors: 1 });
    expect(feedRow("f1").ping_requested_at).toBeNull();
    expect(feedRow("f1").next_read_at!).toBeGreaterThan(secs(at) + 3600);
  });
});

// ------------------------------------------------------------------ WebSub

const HUB = "https://hub.example.net/";
async function hmac(algo: string, secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: algo },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("WebSub discovery", () => {
  it("reads rel=hub and rel=self from a Link header", () => {
    expect(
      parseLinkHeader('<https://hub.example.net/>; rel="hub", <https://x.org/feed>; rel=self')
    ).toEqual([
      { url: "https://hub.example.net/", rels: ["hub"] },
      { url: "https://x.org/feed", rels: ["self"] },
    ]);
    expect(
      discoverHub({
        body: null,
        linkHeader: '<https://hub.example.net/>; rel="hub", <https://x.org/feed>; rel="self"',
        feedUrl: "https://x.org/f",
      })
    ).toEqual({ hub: HUB, topic: "https://x.org/feed" });
  });

  it("reads <link rel=hub> / <atom:link rel=hub> from the body; topic defaults to the feed", () => {
    expect(
      discoverHub({
        body: `<html><head><link href="https://hub.example.net/" rel="hub"></head></html>`,
        linkHeader: null,
        feedUrl: "https://x.org/events/",
      })
    ).toEqual({ hub: HUB, topic: "https://x.org/events/" });
    expect(
      discoverHub({
        body: `<rss><channel><atom:link rel="hub" href="https://hub.example.net/"/><atom:link rel="self" href="https://x.org/feed/"/></channel></rss>`,
        linkHeader: null,
        feedUrl: "https://x.org/f",
      })
    ).toEqual({ hub: HUB, topic: "https://x.org/feed/" });
  });

  it("no hub, or a plain-http hub, is no subscription", () => {
    expect(
      discoverHub({ body: "<html></html>", linkHeader: null, feedUrl: "https://x.org/" })
    ).toBeNull();
    expect(
      discoverHub({
        body: '<link rel="hub" href="http://hub.example.net/">',
        linkHeader: null,
        feedUrl: "https://x.org/",
      })
    ).toBeNull();
  });
});

describe("WebSub subscribe, intent check, notifications", () => {
  async function subscribe(): Promise<{ id: string; secret: string; topic: string }> {
    const web = fakeFetch(() => new Response(null, { status: 202 }));
    expect(
      await ensureWebSubSubscription(db as never, {
        feedId: "f1",
        links: { hub: HUB, topic: FEED_URL },
        now: T0,
        fetchImpl: web.impl,
      })
    ).toBe("subscribed");
    expect(web.calls).toHaveLength(1);
    const form = new URLSearchParams(String(web.calls[0].init?.body));
    const [row] = subs();
    expect(web.calls[0].url).toBe(HUB);
    expect(form.get("hub.mode")).toBe("subscribe");
    expect(form.get("hub.topic")).toBe(FEED_URL);
    expect(form.get("hub.callback")).toBe(`${WEBSUB_CALLBACK_BASE}${row.id}`);
    expect(form.get("hub.secret")).toBe(row.secret);
    expect(Number(form.get("hub.lease_seconds"))).toBeGreaterThan(0);
    expect(row).toMatchObject({ state: "pending", pending_mode: "subscribe" });
    return { id: String(row.id), secret: String(row.secret), topic: FEED_URL };
  }
  const intent = (id: string, q: Record<string, string>) =>
    handleWebSubCallback(
      new Request(`${WEBSUB_CALLBACK_BASE}${id}?${new URLSearchParams(q)}`),
      db as never,
      T0
    );
  const notify = (id: string, body: string, sig: string | null) =>
    handleWebSubCallback(
      new Request(`${WEBSUB_CALLBACK_BASE}${id}`, {
        method: "POST",
        body,
        headers: sig ? { "X-Hub-Signature": sig } : {},
      }),
      db as never,
      T0
    );

  it("echoes hub.challenge ONLY for a matching pending subscription", async () => {
    const { id, topic } = await subscribe();
    const bad = [
      await intent(id, {
        "hub.mode": "subscribe",
        "hub.topic": "https://evil.org/",
        "hub.challenge": "c1",
      }),
      await intent(id, { "hub.mode": "unsubscribe", "hub.topic": topic, "hub.challenge": "c2" }),
      await intent("00000000-0000-0000-0000-000000000000", {
        "hub.mode": "subscribe",
        "hub.topic": topic,
        "hub.challenge": "c3",
      }),
    ];
    for (const r of bad) {
      expect(r.status).toBe(404);
      expect(await r.text()).not.toMatch(/c[123]/);
    }
    expect(subs()[0]).toMatchObject({ state: "pending" });

    const ok = await intent(id, {
      "hub.mode": "subscribe",
      "hub.topic": topic,
      "hub.challenge": "chal-123",
      "hub.lease_seconds": "86400",
    });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("chal-123");
    expect(subs()[0]).toMatchObject({
      state: "active",
      pending_mode: null,
      lease_seconds: 86400,
      lease_expires_at: secs(T0) + 86400,
    });
    // a replayed intent check, with nothing pending, is refused
    const replay = await intent(id, {
      "hub.mode": "subscribe",
      "hub.topic": topic,
      "hub.challenge": "again",
    });
    expect(replay.status).toBe(404);
  });

  it("a bad signature is ignored (still 202); a good one marks the feed due; the body is never parsed", async () => {
    const { id, secret, topic } = await subscribe();
    await intent(id, { "hub.mode": "subscribe", "hub.topic": topic, "hub.challenge": "x" });
    // A body that would be "content" if anyone parsed it — and is not even valid XML/JSON.
    const body = '{"name":"FORGED EVENT","startDate":"2099-01-01"} <not xml';
    const before = raw.prepare("SELECT COUNT(*) AS n FROM promoter_feed_items").get() as {
      n: number;
    };

    for (const sig of [
      null,
      "sha256=deadbeef",
      `sha256=${await hmac("SHA-256", "wrong-secret", body)}`,
      "md5=abc",
    ]) {
      const r = await notify(id, body, sig);
      expect(r.status).toBe(202);
    }
    expect(feedRow("f1").ping_requested_at).toBeNull();
    expect(feedRow("f1").next_read_at).toBe(secs(LATER));

    const good = await notify(id, body, `sha256=${await hmac("SHA-256", secret, body)}`);
    expect(good.status).toBe(202);
    expect(feedRow("f1")).toMatchObject({
      ping_requested_at: secs(T0),
      next_read_at: secs(T0) + 120,
    });
    // sha1 (the WebSub default) works too
    await notify(id, body, `sha1=${await hmac("SHA-1", secret, body)}`);
    expect(feedRow("f1").ping_count).toBe(2);
    // nothing from the body landed anywhere
    expect(raw.prepare("SELECT COUNT(*) AS n FROM promoter_feed_items").get()).toEqual(before);
    expect(JSON.stringify(raw.prepare("SELECT * FROM events").all())).not.toContain("FORGED");
    expect(counts().filter((c) => c.channel === "websub")).toEqual([
      { channel: "websub", outcome: "accepted", count: 2 },
      { channel: "websub", outcome: "websub_bad_signature", count: 4 },
    ]);
  });

  it("a notification to a subscription that is not yet active is ignored", async () => {
    const { id, secret } = await subscribe();
    const body = "x";
    const r = await notify(id, body, `sha256=${await hmac("SHA-256", secret, body)}`);
    expect(r.status).toBe(202);
    expect(feedRow("f1").ping_requested_at).toBeNull();
  });

  it("verifyHubSignature: right key passes, any flipped byte fails", async () => {
    const body = new TextEncoder().encode("payload").buffer as ArrayBuffer;
    const sig = await hmac("SHA-256", "k", "payload");
    expect(await verifyHubSignature("k", `sha256=${sig}`, body)).toBe(true);
    expect(await verifyHubSignature("k", `SHA256=${sig.toUpperCase()}`, body)).toBe(true);
    const flipped = (sig[0] === "0" ? "1" : "0") + sig.slice(1);
    expect(await verifyHubSignature("k", `sha256=${flipped}`, body)).toBe(false);
    expect(await verifyHubSignature("k2", `sha256=${sig}`, body)).toBe(false);
    expect(await verifyHubSignature("k", null, body)).toBe(false);
  });

  it("a feed read that advertises a hub subscribes — only while polling is on — and renews before the lease ends", async () => {
    raw.prepare("UPDATE promoter_event_feeds SET next_read_at = ? WHERE id = 'f1'").run(secs(T0));
    const web = fakeFetch((u) =>
      u === HUB
        ? new Response(null, { status: 202 })
        : new Response(ICS, { headers: { link: `<${HUB}>; rel="hub"` } })
    );
    await pollDueFeeds(db as never, { now: T0, enabled: false, fetchImpl: web.impl });
    expect(web.calls).toHaveLength(0);
    expect(subs()).toHaveLength(0);

    await pollDueFeeds(db as never, { now: T0, enabled: true, fetchImpl: web.impl });
    expect(web.calls.map((c) => c.url)).toEqual([FEED_URL, HUB]);
    expect(subs()).toHaveLength(1);
    const [row] = subs();
    await intent(String(row.id), {
      "hub.mode": "subscribe",
      "hub.topic": FEED_URL,
      "hub.challenge": "c",
      "hub.lease_seconds": String(3 * 86400),
    });

    // Not near expiry: nothing to renew. Within a day of it: renewed.
    expect(await renewWebSubLeases(db as never, { now: T0, fetchImpl: web.impl })).toEqual({
      renewed: 0,
      errors: 0,
    });
    const late = new Date(T0.getTime() + 2.5 * 86_400_000);
    expect(await renewWebSubLeases(db as never, { now: late, fetchImpl: web.impl })).toEqual({
      renewed: 1,
      errors: 0,
    });
    expect(subs()[0]).toMatchObject({ state: "active", pending_mode: "subscribe" });
  });
});
