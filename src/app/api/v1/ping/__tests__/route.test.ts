// @vitest-environment node
/**
 * OPE-1621 — POST /api/v1/ping: the public change ping.
 *
 * Runs on the real 0406 + 0409 + 0412 DDL (the MCP harness). What matters most
 * here is what the caller can NOT learn: every accepted-or-ignored ping gets
 * byte-identical answers, and the lookup runs after the response.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../../../../../../mcp-server/__tests__/setup-db";
import { handleChangePing, PING_LIMITS, type PingDeps } from "@/lib/feed-ping";
import type { BurstLimiter } from "@/lib/burst-limiter";
import { HEARTBEAT_PROBES } from "@/lib/heartbeat";

let db: ReturnType<typeof createTestDb>["db"];
let raw: Database.Database;
const T0 = new Date("2026-11-10T15:00:00Z");
const secs = (d: Date) => Math.floor(d.getTime() / 1000);
const LATER = secs(new Date(T0.getTime() + 6 * 3_600_000));

const ctxWork: Promise<unknown>[] = [];
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({
    env: {},
    ctx: { waitUntil: (p: Promise<unknown>) => ctxWork.push(p) },
  }),
}));
vi.mock("@/lib/cloudflare", () => ({ getCloudflareDb: () => db }));

/** A counting limiter with the DO's semantics: fixed window, `limit` hits allowed. */
function countingLimiter(): BurstLimiter & {
  seen: Array<{ key: string; limit?: number; periodSeconds?: number }>;
} {
  const n = new Map<string, number>();
  const seen: Array<{ key: string; limit?: number; periodSeconds?: number }> = [];
  return {
    seen,
    async limit(o) {
      seen.push(o);
      const c = (n.get(o.key) ?? 0) + 1;
      n.set(o.key, c);
      return { success: c <= (o.limit ?? 5), retryAfterSeconds: 1800 };
    },
  };
}

function deps(over: Partial<PingDeps> = {}): PingDeps & { work: Promise<unknown>[] } {
  const work: Promise<unknown>[] = [];
  return { db: db as never, limiter: null, now: T0, schedule: (p) => work.push(p), work, ...over };
}
const ping = (body: string, type = "application/x-www-form-urlencoded", query = "") =>
  new Request(`https://meetmeatthefair.com/api/v1/ping${query}`, {
    method: "POST",
    body,
    headers: { "content-type": type, "cf-connecting-ip": "203.0.113.9" },
  });
const feedRow = (id: string) =>
  raw
    .prepare(
      "SELECT next_read_at, ping_requested_at, ping_count FROM promoter_event_feeds WHERE id = ?"
    )
    .get(id) as {
    next_read_at: number;
    ping_requested_at: number | null;
    ping_count: number;
  };

beforeEach(() => {
  ({ db, raw } = createTestDb());
  ctxWork.length = 0;
  const p = raw.prepare(
    "INSERT INTO promoters (id, company_name, slug, website) VALUES (?, ?, ?, ?)"
  );
  p.run("p1", "Example Fair", "example-fair", "https://www.examplefair.org");
  p.run("p2", "Shared A", "shared-a", "https://sharedfair.org");
  p.run("p3", "Shared B", "shared-b", "https://sharedfair.org/b");
  p.run("p5", "No Feed", "no-feed", "https://nofeed.org");
  const f = raw.prepare(
    `INSERT INTO promoter_event_feeds (id, promoter_id, feed_url, kind, enabled, next_read_at, created_at, updated_at)
     VALUES (?, ?, ?, 'ical', 1, ?, ?, ?)`
  );
  f.run("f1", "p1", "https://www.examplefair.org/?ical=1", LATER, secs(T0), secs(T0));
  f.run("f2", "p2", "https://sharedfair.org/?ical=1", LATER, secs(T0), secs(T0));
});

describe("POST /api/v1/ping", () => {
  it("accepts form, JSON and ?url= bodies, and marks the feed due once", async () => {
    for (const req of [
      ping("url=https%3A%2F%2Fexamplefair.org%2Fevent%2Fa%2F"),
      ping(JSON.stringify({ url: "https://examplefair.org/event/a/" }), "application/json"),
      ping("", "text/plain", "?url=https://examplefair.org/event/a/"),
    ]) {
      const d = deps();
      const res = await handleChangePing(req, d);
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ ok: true });
      // the lookup runs AFTER the answer
      expect(d.work).toHaveLength(1);
      await Promise.all(d.work);
    }
    const r = feedRow("f1");
    expect(r.ping_count).toBe(3);
    expect(r.next_read_at).toBe(secs(T0) + 120);
  });

  it("known, unknown, shared-domain and no-feed hosts get byte-identical answers", async () => {
    const answers: string[] = [];
    for (const u of [
      "https://examplefair.org/event/a/",
      "https://stranger.org/event/a/",
      "https://sharedfair.org/event/a/",
      "https://nofeed.org/event/a/",
    ]) {
      const d = deps();
      const res = await handleChangePing(ping(`url=${encodeURIComponent(u)}`), d);
      await Promise.all(d.work);
      answers.push(`${res.status} ${JSON.stringify([...res.headers])} ${await res.text()}`);
    }
    expect(new Set(answers).size).toBe(1);
    expect(answers[0]).toMatch(/^202 /);
    expect(answers[0]).not.toMatch(/examplefair|stranger|sharedfair|nofeed/);
    // only the owned host's feed moved; the shared one did not
    expect(feedRow("f1").ping_requested_at).toBe(secs(T0));
    expect(feedRow("f2")).toMatchObject({ ping_requested_at: null, next_read_at: LATER });
    expect(
      raw.prepare("SELECT outcome, count FROM feed_ping_counts ORDER BY outcome").all()
    ).toEqual([
      { outcome: "accepted", count: 1 },
      { outcome: "ignored_no_feed", count: 1 },
      { outcome: "ignored_shared_domain", count: 1 },
      { outcome: "ignored_unknown_host", count: 1 },
    ]);
  });

  it("400 only for a missing or unparseable URL", async () => {
    for (const req of [
      ping(""),
      ping("url="),
      ping("url=not%20a%20url"),
      ping("url=ftp%3A%2F%2Fexamplefair.org%2F"),
      ping("{bad json", "application/json"),
    ]) {
      const d = deps();
      const res = await handleChangePing(req, d);
      expect(res.status).toBe(400);
      expect(d.work).toHaveLength(0);
    }
  });

  it("rate-limits per host at 30/hour, before any lookup, for known and unknown hosts alike", async () => {
    const limiter = countingLimiter();
    for (const host of ["examplefair.org", "stranger.org"]) {
      const statuses: number[] = [];
      for (let i = 0; i < 31; i++) {
        // a different page each time, so only the HOST bucket fills
        const d = deps({ limiter });
        const res = await handleChangePing(ping(`url=https%3A%2F%2F${host}%2Fe%2F${i}`), d);
        statuses.push(res.status);
        await Promise.all(d.work);
      }
      expect(statuses.slice(0, 30).every((s) => s === 202)).toBe(true);
      expect(statuses[30]).toBe(429);
    }
    expect(limiter.seen).toContainEqual({
      key: "rate:feed-ping:host:examplefair.org",
      ...PING_LIMITS.host,
    });
    // the 31st ping to the owned host did not mark anything
    expect(feedRow("f1").ping_count).toBe(30);
    const rl = raw
      .prepare("SELECT count FROM feed_ping_counts WHERE outcome = 'rate_limited'")
      .get() as { count: number };
    expect(rl.count).toBe(2);
  });

  it("rate-limits one URL at 10/hour", async () => {
    const limiter = countingLimiter();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const d = deps({ limiter });
      statuses.push(
        (await handleChangePing(ping("url=https%3A%2F%2Fexamplefair.org%2Fe%2F"), d)).status
      );
      await Promise.all(d.work);
    }
    expect(statuses.filter((s) => s === 202)).toHaveLength(10);
    expect(statuses[10]).toBe(429);
  });

  it("the route answers 202 and defers the work to ctx.waitUntil", async () => {
    const { POST } = await import("../route");
    const res = await POST(ping("url=https%3A%2F%2Fexamplefair.org%2Fe%2F"));
    expect(res.status).toBe(202);
    expect(ctxWork).toHaveLength(1);
    await Promise.all(ctxWork);
    expect(feedRow("f1").ping_count).toBe(1);
  });
});

describe("feed-change-ping heartbeat probe", () => {
  const probe = HEARTBEAT_PROBES.find((p) => p.name === "feed-change-ping");

  it("reads healthy with no outstanding ping, and anchors on the OLDEST outstanding one", async () => {
    expect(probe).toBeDefined();
    const idle = await probe!.lastEvidenceAt(db as never);
    expect(Date.now() - idle!.getTime()).toBeLessThan(60_000);

    raw
      .prepare("UPDATE promoter_event_feeds SET ping_requested_at = ? WHERE id = 'f1'")
      .run(secs(T0));
    raw
      .prepare("UPDATE promoter_event_feeds SET ping_requested_at = ? WHERE id = 'f2'")
      .run(secs(T0) + 600);
    expect((await probe!.lastEvidenceAt(db as never))?.toISOString()).toBe(T0.toISOString());
  });
});
