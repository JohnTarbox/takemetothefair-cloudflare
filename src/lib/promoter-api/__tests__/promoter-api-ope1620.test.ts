/**
 * OPE-1620 — the promoter events API: request signing (pure), the routes end
 * to end against the MCP suite's full schema with the real 0410 + 0411 DDL,
 * key management, and the OpenAPI document ↔ route files.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createTestDb } from "../../../../mcp-server/__tests__/setup-db";

let raw: Database.Database;
let db: ReturnType<typeof createTestDb>["db"];
let sessionUser = "u-joyce";
let limiterHits = 0;
let limiterMax: number | null = null;
vi.mock("@/lib/cloudflare", () => ({ getCloudflareDb: () => db }));
vi.mock("@/lib/api-auth", () => ({
  requireVerifiedSession: vi.fn(async () => ({
    ok: true,
    userId: sessionUser,
    email: "someone@example.com",
  })),
}));
// The BurstCounter DO, replaced by an in-memory counter the 429 test arms.
vi.mock("@/lib/burst-limiter", () => ({
  getBurstLimiter: () =>
    limiterMax === null
      ? null
      : {
          limit: async ({ max }: { key: string; max?: number }) => {
            limiterHits++;
            return limiterHits > (max ?? limiterMax!)
              ? { success: false, retryAfterSeconds: 42 }
              : { success: true };
          },
        },
}));

import {
  MAX_SKEW_SECONDS,
  PROMOTER_API_RATE,
  authenticate,
  signRequest,
  timingSafeEqual,
  type ApiKeyRecord,
} from "../auth";
import { PROMOTER_API_OPENAPI } from "../openapi";
import { POST as eventsPost, GET as eventsGet } from "@/app/api/v1/promoter/events/route";
import { PATCH as eventPatch } from "@/app/api/v1/promoter/events/[externalId]/route";
import { POST as eventCancel } from "@/app/api/v1/promoter/events/[externalId]/cancel/route";
import { GET as openapiGet } from "@/app/api/v1/openapi.json/route";
import { GET as keysGet, POST as keysPost } from "@/app/api/promoter/api-keys/route";
import { POST as keyRevoke } from "@/app/api/promoter/api-keys/[keyId]/revoke/route";
import { HEARTBEAT_PROBES } from "@/lib/heartbeat";

const ROOT = join(__dirname, "../../../..");
const MIGRATION = readFileSync(join(ROOT, "drizzle/0411_ope1620_promoter_api.sql"), "utf8");

// ------------------------------------------------------------------ pure signing

describe("authenticate (pure)", () => {
  const key: ApiKeyRecord = {
    keyId: "mmk_0123456789abcdef01234567",
    secret: "a".repeat(64),
    promoterId: "p1",
    promoterUserId: "u1",
    revokedAt: null,
  };
  const now = 1_800_000_000;
  const deps = (over: Partial<Parameters<typeof authenticate>[3]> = {}) => {
    const seen = new Set<string>();
    return {
      lookupKey: async (k: string) => (k === key.keyId ? key : null),
      consumeRequestId: async (k: string, r: string) => {
        const id = `${k}|${r}`;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      },
      ...over,
    };
  };
  const headers = async (
    over: { ts?: number; req?: string; body?: string; sig?: string; keyId?: string } = {}
  ) => {
    const ts = String(over.ts ?? now);
    const req = over.req ?? "req-1";
    const body = over.body ?? '{"a":1}';
    return new Headers({
      "x-mmatf-key": over.keyId ?? key.keyId,
      "x-mmatf-timestamp": ts,
      "x-mmatf-request-id": req,
      "x-mmatf-signature": over.sig ?? (await signRequest(key.secret, ts, req, body)),
    });
  };

  it("accepts a correctly signed request and returns its promoter", async () => {
    const r = await authenticate(await headers(), '{"a":1}', now, deps());
    expect(r).toMatchObject({ ok: true, key: { promoterId: "p1" }, requestId: "req-1" });
  });

  it("rejects a bad signature (401), a body changed after signing, and a different secret", async () => {
    const d = deps();
    const tampered = await authenticate(await headers(), '{"a":2}', now, d);
    expect(tampered).toMatchObject({ ok: false, status: 401, code: "bad_signature" });
    const wrongSecret = await signRequest("b".repeat(64), String(now), "req-1", '{"a":1}');
    expect(
      await authenticate(await headers({ sig: wrongSecret }), '{"a":1}', now, d)
    ).toMatchObject({ ok: false, status: 401, code: "bad_signature" });
    expect(await authenticate(await headers({ sig: "sha256=" }), '{"a":1}', now, d)).toMatchObject({
      code: "bad_signature",
    });
  });

  it("rejects a timestamp more than 300 s away in either direction, accepts the edge", async () => {
    for (const ts of [now - MAX_SKEW_SECONDS - 1, now + MAX_SKEW_SECONDS + 1]) {
      const r = await authenticate(await headers({ ts }), '{"a":1}', now, deps());
      expect(r).toMatchObject({ ok: false, status: 401, code: "stale_timestamp" });
    }
    const edge = await authenticate(
      await headers({ ts: now - MAX_SKEW_SECONDS }),
      '{"a":1}',
      now,
      deps()
    );
    expect(edge.ok).toBe(true);
  });

  it("rejects a replayed request id (409), and records the id only after the signature verifies", async () => {
    const d = deps();
    expect((await authenticate(await headers(), '{"a":1}', now, d)).ok).toBe(true);
    expect(await authenticate(await headers(), '{"a":1}', now, d)).toMatchObject({
      ok: false,
      status: 409,
      code: "replayed_request",
    });
    // A forged request with a fresh id does not burn that id for the real sender.
    await authenticate(await headers({ req: "req-2", sig: "sha256=00" }), '{"a":1}', now, d);
    expect((await authenticate(await headers({ req: "req-2" }), '{"a":1}', now, d)).ok).toBe(true);
  });

  it("rejects an unknown key, a revoked key and missing headers (401)", async () => {
    expect(
      await authenticate(
        await headers({ keyId: "mmk_ffffffffffffffffffffffff" }),
        '{"a":1}',
        now,
        deps()
      )
    ).toMatchObject({ status: 401, code: "invalid_key" });
    expect(
      await authenticate(await headers(), '{"a":1}', now, {
        ...deps(),
        lookupKey: async () => ({ ...key, revokedAt: new Date() }),
      })
    ).toMatchObject({ status: 401, code: "invalid_key" });
    expect(await authenticate(new Headers(), "", now, deps())).toMatchObject({
      status: 401,
      code: "missing_auth_headers",
    });
  });

  it("a rate-limited request is 429 and does not consume its request id", async () => {
    let allow = false;
    const d = deps({
      rateLimit: async () =>
        allow ? { allowed: true as const } : { allowed: false as const, retryAfterSeconds: 7 },
    });
    expect(await authenticate(await headers(), '{"a":1}', now, d)).toMatchObject({
      status: 429,
      code: "rate_limited",
      retryAfterSeconds: 7,
    });
    allow = true;
    expect((await authenticate(await headers(), '{"a":1}', now, d)).ok).toBe(true);
  });

  it("timingSafeEqual compares whole strings", () => {
    expect(timingSafeEqual("sha256=abc", "sha256=abc")).toBe(true);
    expect(timingSafeEqual("sha256=abd", "sha256=abc")).toBe(false);
    expect(timingSafeEqual("sha256=ab", "sha256=abc")).toBe(false);
    expect(timingSafeEqual("sha256=abcd", "sha256=abc")).toBe(false);
  });
});

// ------------------------------------------------------------------ routes

const sec = (ymd: string) =>
  Math.floor(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10), 12) / 1000);
const n = (sql: string, ...p: unknown[]) => (raw.prepare(sql).get(...p) as { n: number }).n;
const BASE = "https://meetmeatthefair.com";

let reqSeq = 0;
async function call(
  key: { key_id: string; secret: string },
  method: string,
  path: string,
  payload?: unknown,
  over: { ts?: number; requestId?: string; sig?: string } = {}
): Promise<Response> {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const ts = String(over.ts ?? Math.floor(Date.now() / 1000));
  const requestId = over.requestId ?? `req-${++reqSeq}`;
  const headers = {
    "content-type": "application/json",
    "x-mmatf-key": key.key_id,
    "x-mmatf-timestamp": ts,
    "x-mmatf-request-id": requestId,
    "x-mmatf-signature": over.sig ?? (await signRequest(key.secret, ts, requestId, body)),
  };
  const request = new Request(`${BASE}${path}`, {
    method,
    headers,
    body: method === "GET" ? undefined : body,
  });
  const m = /^\/api\/v1\/promoter\/events(?:\/([^/?]+))?(\/cancel)?/.exec(path)!;
  const params = Promise.resolve({ externalId: m[1] ?? "" });
  if (m[2]) return eventCancel(request, { params });
  if (m[1]) return eventPatch(request, { params });
  return method === "GET" ? eventsGet(request) : eventsPost(request);
}

async function mintKey(user = "u-joyce", name = "Website sync") {
  sessionUser = user;
  const res = await keysPost(
    new Request(`${BASE}/api/promoter/api-keys`, {
      method: "POST",
      body: JSON.stringify({ name }),
    })
  );
  expect(res.status).toBe(201);
  return (await res.json()) as { key_id: string; secret: string };
}

const FALL = {
  external_id: "fall-2027",
  name: "Fall Craft Fair",
  start_date: "2027-10-02",
  end_date: "2027-10-03",
  daily_hours: "9am-4pm",
  venue_name: "Grange Hall",
  city: "Concord",
  state: "NH",
  booth_fee_min: 60,
  admission: "Free",
};

beforeEach(() => {
  ({ raw, db } = createTestDb());
  // The 0411 DDL is loaded by createTestDb (OPE-1647).
  raw["exec"](
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_event_days_event_date_vendor ON event_days(event_id, date, vendor_only)"
  );
  raw
    .prepare(
      "INSERT INTO users (id, email, role) VALUES ('u-joyce','joyce@example.com','PROMOTER'), ('u-other','other@example.com','PROMOTER'), ('u-new','new@example.com','PROMOTER')"
    )
    .run();
  raw
    .prepare(
      "INSERT INTO promoters (id, company_name, slug, user_id, claimed) VALUES ('p-joyce','Joyce Shows','joyce','u-joyce',1), ('p-other','Other Org','other','u-other',1), ('p-new','Unclaimed','unclaimed','u-new',0)"
    )
    .run();
  raw
    .prepare(
      "INSERT INTO events (id, name, slug, promoter_id, start_date, end_date, status, source_url) VALUES ('e-theirs','Laconia Antiques Show','laconia','p-other',?,?,'APPROVED','https://other.example/laconia')"
    )
    .run(sec("2027-07-04"), sec("2027-07-04"));
  sessionUser = "u-joyce";
  limiterHits = 0;
  limiterMax = null;
});
afterEach(() => raw.close());

describe("POST / PATCH / cancel round trip", () => {
  it("creates PENDING and cited, then stages an update and a cancellation without writing the event", async () => {
    const key = await mintKey();

    // create
    const created = await call(key, "POST", "/api/v1/promoter/events", FALL);
    expect(created.status).toBe(201);
    const c = (await created.json()) as { event_id: string; outcome: string; status: string };
    expect(c).toMatchObject({ external_id: "fall-2027", outcome: "created", status: "PENDING" });
    const ev = raw
      .prepare("SELECT status, promoter_id, vendor_fee_min_cents f FROM events WHERE id=?")
      .get(c.event_id) as { status: string; promoter_id: string; f: number };
    expect(ev).toEqual({ status: "PENDING", promoter_id: "p-joyce", f: 6000 });
    const cites = raw
      .prepare(
        "SELECT DISTINCT provenance_kind, source_name, source_url, notes FROM event_data_citations WHERE event_id=?"
      )
      .all(c.event_id) as Array<{
      provenance_kind: string;
      source_name: string;
      source_url: string;
      notes: string;
    }>;
    expect(new Set(cites.map((x) => x.provenance_kind))).toEqual(new Set(["promoter_api"]));
    expect(cites[0].source_name).toBe("Promoter API");
    expect(cites[0].source_url).toBe(`promoter-api:${key.key_id}#external_id=fall-2027`);
    expect(JSON.parse(cites[0].notes)).toMatchObject({
      key_id: key.key_id,
      external_id: "fall-2027",
      channel: "api",
    });
    expect(
      n(
        "SELECT count(*) n FROM promoter_api_event_refs WHERE event_id=? AND external_id='fall-2027'",
        c.event_id
      )
    ).toBe(1);
    expect(n("SELECT count(*) n FROM event_days WHERE event_id=?", c.event_id)).toBe(2);

    // update via POST: staged, the live event untouched
    const up = await call(key, "POST", "/api/v1/promoter/events", { ...FALL, booth_fee_min: 75 });
    expect(up.status).toBe(200);
    expect(await up.json()).toMatchObject({
      outcome: "update_staged",
      event_id: c.event_id,
      changes: { booth_fee_min: { current: "60.00", proposed: "75.00" } },
    });
    expect(n("SELECT vendor_fee_min_cents n FROM events WHERE id=?", c.event_id)).toBe(6000);
    expect(
      n(
        "SELECT count(*) n FROM event_review_flags WHERE event_id=? AND reason='promoter_import_update' AND cleared_at IS NULL",
        c.event_id
      )
    ).toBe(1);

    // PATCH: partial, staged
    const patched = await call(key, "PATCH", "/api/v1/promoter/events/fall-2027", {
      description: "Sixty artisans.",
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({
      outcome: "update_staged",
      changes: { description: { current: null, proposed: "Sixty artisans." } },
    });
    expect(
      (raw.prepare("SELECT description d FROM events WHERE id=?").get(c.event_id) as { d: null }).d
    ).toBeNull();
    // A one-day move by start_date alone; city is reported as not compared.
    const moved = await call(key, "PATCH", "/api/v1/promoter/events/fall-2027", {
      start_date: "2027-10-01",
      city: "Bow",
    });
    expect(await moved.json()).toMatchObject({
      outcome: "update_staged",
      changes: { start_date: { current: "2027-10-02", proposed: "2027-10-01" } },
      not_compared: ["city"],
    });

    // cancel: staged, flagged, status unchanged
    const cancelled = await call(key, "POST", "/api/v1/promoter/events/fall-2027/cancel", {
      reason: "Hall flooded",
    });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({
      outcome: "cancel_staged",
      status: "PENDING",
      event_id: c.event_id,
    });
    expect(n("SELECT count(*) n FROM events WHERE id=? AND status='PENDING'", c.event_id)).toBe(1);
    expect(
      n(
        "SELECT count(*) n FROM event_review_flags WHERE event_id=? AND reason='promoter_cancel_request'",
        c.event_id
      )
    ).toBe(1);
    const staged = raw
      .prepare(
        "SELECT proposed_changes p, channel FROM promoter_import_rows WHERE event_id=? AND outcome='cancel_staged'"
      )
      .get(c.event_id) as { p: string; channel: string };
    expect(staged.channel).toBe("api");
    expect(JSON.parse(staged.p)).toEqual({
      status: { current: "PENDING", proposed: "CANCELLED" },
      reason: { current: null, proposed: "Hall flooded" },
    });

    // list
    const list = await call(key, "GET", "/api/v1/promoter/events?limit=10");
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      items: [{ external_id: "fall-2027", event_id: c.event_id, status: "PENDING" }],
      next_cursor: null,
    });
    // key usage is recorded
    expect(
      n(
        "SELECT count(*) n FROM promoter_api_keys WHERE key_id=? AND last_used_at IS NOT NULL",
        key.key_id
      )
    ).toBe(1);
  });

  it("the same external_id posted twice gives ONE event; the repeat is 'unchanged'", async () => {
    const key = await mintKey();
    const before = n("SELECT count(*) n FROM events");
    const a = await call(key, "POST", "/api/v1/promoter/events", FALL);
    const b = await call(key, "POST", "/api/v1/promoter/events", FALL);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    const bj = (await b.json()) as { outcome: string; event_id: string };
    expect(bj.outcome).toBe("unchanged");
    expect(bj.event_id).toBe(((await a.json()) as { event_id: string }).event_id);
    expect(n("SELECT count(*) n FROM events") - before).toBe(1);
    expect(n("SELECT count(*) n FROM promoter_api_event_refs")).toBe(1);
    expect(
      n("SELECT count(*) n FROM event_review_flags WHERE reason='promoter_import_update'")
    ).toBe(0);
  });

  it("two concurrent first posts of one external_id still create one event", async () => {
    const key = await mintKey();
    const before = n("SELECT count(*) n FROM events");
    const res = await Promise.all([
      call(key, "POST", "/api/v1/promoter/events", FALL),
      call(key, "POST", "/api/v1/promoter/events", FALL),
    ]);
    expect(res.map((r) => r.status).sort()).toEqual(expect.arrayContaining([201]));
    expect(n("SELECT count(*) n FROM events") - before).toBe(1);
  });

  it("a new external_id that matches the promoter's own event binds to it instead of creating", async () => {
    raw
      .prepare(
        "INSERT INTO events (id, name, slug, promoter_id, start_date, end_date, status, source_url) VALUES ('e-mine','Keene Fall Show','keene','p-joyce',?,?,'APPROVED','https://joyce.example/keene')"
      )
      .run(sec("2027-09-25"), sec("2027-09-25"));
    const key = await mintKey();
    const r = await call(key, "POST", "/api/v1/promoter/events", {
      external_id: "keene",
      name: "Keene Fall Show",
      start_date: "2027-09-25",
      city: "Keene",
      state: "NH",
      event_url: "https://joyce.example/keene",
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ event_id: "e-mine", status: "APPROVED" });
    // A second external_id for the same event is refused rather than double-linked.
    const again = await call(key, "POST", "/api/v1/promoter/events", {
      external_id: "keene-2",
      name: "Keene Fall Show",
      start_date: "2027-09-25",
      city: "Keene",
      state: "NH",
      event_url: "https://joyce.example/keene",
    });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe(
      "conflict_external_id"
    );
  });
});

describe("rejections", () => {
  it("a bad signature, a stale timestamp and a replayed request id are refused, and nothing is written", async () => {
    const key = await mintKey();
    const bad = await call(key, "POST", "/api/v1/promoter/events", FALL, {
      sig: "sha256=" + "0".repeat(64),
    });
    expect(bad.status).toBe(401);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("bad_signature");
    const stale = await call(key, "POST", "/api/v1/promoter/events", FALL, {
      ts: Math.floor(Date.now() / 1000) - 301,
    });
    expect(stale.status).toBe(401);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe(
      "stale_timestamp"
    );
    expect(n("SELECT count(*) n FROM promoter_api_event_refs")).toBe(0);

    const ok = await call(key, "POST", "/api/v1/promoter/events", FALL, { requestId: "once" });
    expect(ok.status).toBe(201);
    const replay = await call(key, "POST", "/api/v1/promoter/events", FALL, {
      requestId: "once",
    });
    expect(replay.status).toBe(409);
    expect(((await replay.json()) as { error: { code: string } }).error.code).toBe(
      "replayed_request"
    );
  });

  it("never logs the secret or the signature", async () => {
    const key = await mintKey();
    const sig = "sha256=" + "e".repeat(64);
    await call(key, "POST", "/api/v1/promoter/events", FALL, { sig });
    const logs = raw.prepare("SELECT message, context, url FROM error_logs").all() as Array<
      Record<string, string>
    >;
    expect(logs.length).toBeGreaterThan(0); // the failure WAS logged
    const all = JSON.stringify(logs);
    expect(all).toContain("bad_signature");
    expect(all).toContain(key.key_id);
    expect(all).not.toContain(key.secret);
    expect(all).not.toContain("e".repeat(64));
  });

  it("a key cannot touch another promoter's refs or events", async () => {
    const joyce = await mintKey("u-joyce");
    const other = await mintKey("u-other", "Other sync");
    const created = await call(joyce, "POST", "/api/v1/promoter/events", FALL);
    expect(created.status).toBe(201);
    // Other's key: Joyce's external_id is simply unknown to it.
    expect(
      (await call(other, "PATCH", "/api/v1/promoter/events/fall-2027", { name: "X" })).status
    ).toBe(404);
    expect((await call(other, "POST", "/api/v1/promoter/events/fall-2027/cancel")).status).toBe(
      404
    );
    expect(await (await call(other, "GET", "/api/v1/promoter/events")).json()).toMatchObject({
      items: [],
    });
    // Other posting the same external_id makes its OWN ref; dedup then finds
    // Joyce's event, which is another organizer's → 409, nothing linked.
    const clash = await call(other, "POST", "/api/v1/promoter/events", FALL);
    expect(clash.status).toBe(409);
    expect(((await clash.json()) as { error: { code: string } }).error.code).toBe(
      "conflict_other_promoter"
    );
    expect(n("SELECT count(*) n FROM promoter_api_event_refs WHERE promoter_id='p-other'")).toBe(0);
    // And Joyce posting a copy of Other's listed event is the same 409.
    const theirs = await call(joyce, "POST", "/api/v1/promoter/events", {
      external_id: "laconia",
      name: "Laconia Antiques Show",
      start_date: "2027-07-04",
      city: "Laconia",
      state: "NH",
      event_url: "https://other.example/laconia",
    });
    expect(theirs.status).toBe(409);
  });

  it("a revoked key fails with 401", async () => {
    const key = await mintKey();
    expect((await call(key, "GET", "/api/v1/promoter/events")).status).toBe(200);
    const rev = await keyRevoke(new Request(`${BASE}/x`, { method: "POST" }), {
      params: Promise.resolve({ keyId: key.key_id }),
    });
    expect(rev.status).toBe(200);
    const after = await call(key, "GET", "/api/v1/promoter/events");
    expect(after.status).toBe(401);
    expect(((await after.json()) as { error: { code: string } }).error.code).toBe("invalid_key");
  });

  it("validation errors are 422 with [{field, message}]", async () => {
    const key = await mintKey();
    const r = await call(key, "POST", "/api/v1/promoter/events", {
      external_id: "bad-1",
      name: "Broken",
      start_date: "2027-13-40",
      city: "Concord",
      state: "NY",
      booth_fee_min: "lots",
      colour: "red",
    });
    expect(r.status).toBe(422);
    const body = (await r.json()) as {
      error: { code: string; errors: Array<{ field: string | null; message: string }> };
    };
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.errors).toEqual([{ field: "colour", message: "Unknown field." }]);
    const r2 = await call(key, "POST", "/api/v1/promoter/events", {
      external_id: "bad-1",
      name: "Broken",
      start_date: "2027-13-40",
      city: "Concord",
      state: "NY",
      booth_fee_min: "lots",
    });
    expect(r2.status).toBe(422);
    const errs = ((await r2.json()) as typeof body).error.errors;
    expect(errs.map((e) => e.field).sort()).toEqual(["booth_fee_min", "start_date", "state"]);
    expect(errs.find((e) => e.field === "state")!.message).toMatch(/State "NY"/);
    const missing = await call(key, "POST", "/api/v1/promoter/events", { external_id: "m" });
    expect(((await missing.json()) as typeof body).error.errors.map((e) => e.field).sort()).toEqual(
      ["city", "name", "start_date", "state"]
    );
    const badId = await call(key, "POST", "/api/v1/promoter/events", {
      ...FALL,
      external_id: "has space",
    });
    expect(((await badId.json()) as typeof body).error.errors[0].field).toBe("external_id");
    expect(n("SELECT count(*) n FROM promoter_api_event_refs")).toBe(0);
  });

  it("rate-limits per key with 429 + Retry-After", async () => {
    const key = await mintKey();
    limiterMax = PROMOTER_API_RATE.max;
    for (let i = 0; i < PROMOTER_API_RATE.max; i++)
      expect((await call(key, "GET", "/api/v1/promoter/events")).status).toBe(200);
    const limited = await call(key, "GET", "/api/v1/promoter/events");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("42");
    expect(((await limited.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
  });
});

describe("key management (portal)", () => {
  it("returns the secret once, lists keys without it, and refuses other promoters' keys", async () => {
    const key = await mintKey();
    expect(key.key_id).toMatch(/^mmk_[0-9a-f]{24}$/);
    expect(key.secret).toMatch(/^[0-9a-f]{64}$/);
    const list = await keysGet();
    const text = await list.text();
    expect(text).toContain(key.key_id);
    expect(text).not.toContain(key.secret);
    expect(text).not.toContain("secret");
    sessionUser = "u-other";
    const theirs = await keyRevoke(new Request(`${BASE}/x`, { method: "POST" }), {
      params: Promise.resolve({ keyId: key.key_id }),
    });
    expect(theirs.status).toBe(404);
    expect(n("SELECT count(*) n FROM promoter_api_keys WHERE revoked_at IS NULL")).toBe(1);
  });

  it("an unclaimed promoter cannot create keys", async () => {
    sessionUser = "u-new";
    const res = await keysPost(
      new Request(`${BASE}/api/promoter/api-keys`, {
        method: "POST",
        body: JSON.stringify({ name: "x" }),
      })
    );
    expect(res.status).toBe(403);
    expect(n("SELECT count(*) n FROM promoter_api_keys")).toBe(0);
  });
});

describe("OpenAPI document", () => {
  it("is 3.1, served at /api/v1/openapi.json, and every path exists as a route file with that method", async () => {
    const res = openapiGet();
    expect(res.status).toBe(200);
    const spec = (await res.json()) as typeof PROMOTER_API_OPENAPI;
    expect(spec.openapi).toBe("3.1.0");
    const paths = Object.entries(spec.paths);
    expect(paths.length).toBeGreaterThanOrEqual(3);
    for (const [path, ops] of paths) {
      // /api/v1/promoter/events/{external_id} → src/app/api/v1/promoter/events/[<any>]/route.ts
      let dir = join(ROOT, "src/app");
      for (const seg of path.split("/").filter(Boolean)) {
        if (seg.startsWith("{")) {
          const dyn = readdirSync(dir).find((d) => /^\[[^\].]+\]$/.test(d));
          expect(dyn, `${path}: no dynamic segment under ${dir}`).toBeDefined();
          dir = join(dir, dyn!);
        } else dir = join(dir, seg);
      }
      const file = join(dir, "route.ts");
      expect(existsSync(file), `${path} → ${file}`).toBe(true);
      const src = readFileSync(file, "utf8");
      for (const method of Object.keys(ops))
        expect(src, `${path} ${method}`).toMatch(
          new RegExp(`export async function ${method.toUpperCase()}\\b`)
        );
    }
  });
});

describe("heartbeat probe (OPE-246)", () => {
  it("is registered and seeded dormant (enabled_at NULL)", () => {
    expect(HEARTBEAT_PROBES.some((p) => p.name === "promoter-api-write")).toBe(true);
    expect(MIGRATION).toMatch(/'promoter-api-write',\s*NULL,/);
  });
});
