/**
 * OPE-1648 — every outbound fetch the organizer-feed reader makes goes through
 * the OPE-1370 guard (`guardedFetch`): each redirect hop is host-checked, the
 * body is streamed under a cap, and TEC paging stays on the feed's own host.
 *
 * Nothing touches the network: every fetch is a fake that records its calls,
 * so "the target was never fetched" is asserted from the call log, not
 * inferred from an error message.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { isGuardedFetchError } from "@takemetothefair/site-fetch";
import { createTestDb, type TestDb } from "./setup-db.js";
import { fetchConditional, fetchText } from "../src/feeds/fetch-feed.js";
import { readTecFeed } from "../src/feeds/tec.js";
import { ensureWebSubSubscription } from "../src/feeds/websub.js";

const FEED = "https://www.examplefair.org/?ical=1";
const ICS = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nEND:VCALENDAR\r\n";
const CAP = 5 * 1024 * 1024; // fetch-feed.ts MAX_BYTES

function fakeFetch(respond: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (u: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(u), init });
    return respond(String(u), init);
  }) as typeof fetch;
  return { impl, calls };
}

const redirectTo = (location: string, status = 302) =>
  new Response(null, { status, headers: { location } });

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

describe("calendar read: redirects are host-checked on every hop", () => {
  for (const target of ["http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/"]) {
    it(`a feed URL that 302s to ${target} is refused and the target is never fetched`, async () => {
      const web = fakeFetch((u) => (u === FEED ? redirectTo(target) : new Response(ICS)));
      const err = await caught(fetchConditional(FEED, { fetchImpl: web.impl }));
      expect(isGuardedFetchError(err) && err.code).toBe("blocked_host");
      // positive landmark: the feed itself WAS fetched — the guard ran on hop 1, not hop 0
      expect(web.calls.map((c) => c.url)).toEqual([FEED]);
    });
  }

  it("a redirect hop on a public host is still followed (the guard is not a blanket refusal)", async () => {
    const moved = "https://calendar.examplefair.org/events.ics";
    const web = fakeFetch((u) => (u === FEED ? redirectTo(moved, 301) : new Response(ICS)));
    const r = await fetchConditional(FEED, { fetchImpl: web.impl });
    expect(r.status).toBe("ok");
    expect(r.status === "ok" && r.body).toBe(ICS);
    expect(web.calls.map((c) => c.url)).toEqual([FEED, moved]);
    // every hop goes out with redirect: manual, so `fetch` itself never follows one
    expect(web.calls.every((c) => c.init?.redirect === "manual")).toBe(true);
  });

  it("the JSON-LD follow-up page (fetchText) gets the same per-hop check", async () => {
    const page = "https://examplefair.org/event/harvest/";
    const web = fakeFetch(() => redirectTo("http://10.0.0.5/"));
    const err = await caught(fetchText(page, web.impl));
    expect(isGuardedFetchError(err) && err.code).toBe("blocked_host");
    expect(web.calls.map((c) => c.url)).toEqual([page]);
  });

  it("a 304 is still a conditional-GET hit, not a redirect", async () => {
    const web = fakeFetch(() => new Response(null, { status: 304, headers: { etag: '"v2"' } }));
    const r = await fetchConditional(FEED, { fetchImpl: web.impl, etag: '"v1"' });
    expect(r).toEqual({ status: "not_modified", etag: '"v2"', lastModified: null });
    expect(new Headers(web.calls[0].init?.headers).get("if-none-match")).toBe('"v1"');
  });
});

describe("calendar read: the body is streamed under the cap", () => {
  it("a chunked body larger than the cap, with no Content-Length, aborts at the cap", async () => {
    const CHUNK = 256 * 1024;
    const SERVE_CHUNKS = 64; // 16 MB on offer, ~3× the cap
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (pulled >= SERVE_CHUNKS) return c.close();
        pulled++;
        c.enqueue(new Uint8Array(CHUNK).fill(65));
      },
    });
    let served: Response | null = null;
    const web = fakeFetch(() => (served = new Response(body, { status: 200 })));

    const err = await caught(fetchConditional(FEED, { fetchImpl: web.impl }));
    // positive landmark: the response really was chunked — no Content-Length
    // for the old pre-read check to catch
    expect(served).not.toBeNull();
    expect(served!.headers.get("content-length")).toBeNull();
    expect(isGuardedFetchError(err) && err.code).toBe("too_large");
    expect(String((err as Error).message)).toContain(String(CAP));
    const offered = SERVE_CHUNKS * CHUNK;
    const read = pulled * CHUNK;
    expect(read).toBeLessThan(offered);
    expect(read).toBeLessThanOrEqual(CAP + 2 * CHUNK); // stopped within a chunk or so of the cap
  });

  it("a declared Content-Length over the cap is refused before the body is read", async () => {
    const web = fakeFetch(
      () => new Response("tiny", { status: 200, headers: { "content-length": String(CAP + 1) } })
    );
    const err = await caught(fetchConditional(FEED, { fetchImpl: web.impl }));
    expect(isGuardedFetchError(err) && err.code).toBe("too_large");
  });
});

describe("TEC REST paging", () => {
  const SITE = "https://grange.org/";
  const page = (events: unknown[], next: string | null) =>
    new Response(JSON.stringify({ events, next_rest_url: next ?? undefined }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const ev = (id: number) => ({
    id,
    title: `Supper ${id}`,
    start_date: "2026-12-05 17:00:00",
    end_date: "2026-12-05 19:00:00",
  });
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it("a next_rest_url on a DIFFERENT host stops paging at that page, and the refusal is logged", async () => {
    const web = fakeFetch(() =>
      page([ev(1)], "https://evil.example.net/wp-json/tribe/events/v1/events?page=2")
    );
    const r = await readTecFeed(SITE, {
      startDate: "2026-12-01",
      endDate: "2026-12-31",
      fetchImpl: web.impl,
    });
    expect(web.calls).toHaveLength(1);
    expect(web.calls[0].url.startsWith("https://grange.org/wp-json/tribe/events/v1/events")).toBe(
      true
    );
    expect(r.pages).toBe(1);
    expect(r.events).toHaveLength(1);
    expect(r.refusedNextHost).toBe("evil.example.net");
    const lines = warn.mock.calls.map((a) => String(a[0]));
    expect(
      lines.some((l) => l.includes("refused next_rest_url") && l.includes("evil.example.net"))
    ).toBe(true);
  });

  it("a same-host next_rest_url (www. or not) is followed", async () => {
    let n = 0;
    const web = fakeFetch(() => {
      n++;
      return n === 1
        ? page([ev(1)], "https://www.grange.org/wp-json/tribe/events/v1/events?page=2")
        : page([ev(2)], null);
    });
    const r = await readTecFeed(SITE, {
      startDate: "2026-12-01",
      endDate: "2026-12-31",
      fetchImpl: web.impl,
    });
    expect(r.pages).toBe(2);
    expect(r.events).toHaveLength(2);
    expect(r.refusedNextHost).toBeNull();
    expect(web.calls[1].url).toBe("https://www.grange.org/wp-json/tribe/events/v1/events?page=2");
    expect(warn).not.toHaveBeenCalled();
  });

  it("a TEC page that redirects to a blocked host is refused", async () => {
    const web = fakeFetch(() => redirectTo("http://169.254.169.254/"));
    const err = await caught(
      readTecFeed(SITE, { startDate: "2026-12-01", endDate: "2026-12-31", fetchImpl: web.impl })
    );
    expect(isGuardedFetchError(err) && err.code).toBe("blocked_host");
    expect(web.calls).toHaveLength(1);
  });
});

describe("WebSub hub POST", () => {
  let db: TestDb;
  let raw: Database.Database;
  const T0 = new Date("2026-11-10T15:00:00Z");
  const WEBSUB_ON = { FEED_POLLING_ENABLED: "true", WEBSUB_ENABLED: "true" };
  beforeEach(() => {
    ({ db, raw } = createTestDb());
    raw
      .prepare(
        "INSERT INTO promoters (id, company_name, slug, website) VALUES ('p1','P','p','https://www.examplefair.org')"
      )
      .run();
    raw
      .prepare(
        `INSERT INTO promoter_event_feeds (id, promoter_id, feed_url, kind, enabled, created_at, updated_at)
         VALUES ('f1','p1',?, 'ical', 1, 0, 0)`
      )
      .run(FEED);
  });
  const lastError = () =>
    (
      raw.prepare("SELECT last_error FROM feed_websub_subscriptions").get() as {
        last_error: string | null;
      }
    ).last_error;

  it("a hub on a blocked host is never contacted", async () => {
    const web = fakeFetch(() => new Response(null, { status: 202 }));
    const r = await ensureWebSubSubscription(db as never, {
      feedId: "f1",
      links: { hub: "https://127.0.0.1/hub", topic: FEED },
      now: T0,
      fetchImpl: web.impl,
      flags: WEBSUB_ON,
    });
    expect(r).toBe("error");
    expect(web.calls).toHaveLength(0);
    expect(lastError()).toContain("Blocked internal host");
  });

  it("a hub that redirects the subscribe POST is refused, not followed", async () => {
    const web = fakeFetch(() => redirectTo("https://hub2.example.net/", 307));
    const r = await ensureWebSubSubscription(db as never, {
      feedId: "f1",
      links: { hub: "https://hub.example.net/", topic: FEED },
      now: T0,
      fetchImpl: web.impl,
      flags: WEBSUB_ON,
    });
    expect(r).toBe("error");
    expect(web.calls.map((c) => c.url)).toEqual(["https://hub.example.net/"]);
    expect(web.calls[0].init?.method).toBe("POST");
    expect(lastError()).toContain("redirects");
  });
});
