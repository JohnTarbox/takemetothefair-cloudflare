/**
 * OPE-363 (John's ruling 2026-10-13) — the funnel canary stamps with its OWN
 * key, `CANARY_STAMP_KEY`, and that key unlocks this one route and nothing else.
 *
 * The auth wrappers are REAL here (`with-auth` + `api-auth`); only the env, the
 * DB and the session are stubbed. A test that mocked the wrapper would prove
 * the route's own branch and nothing about whether another route might honour
 * the key — which is the property this ticket exists to guarantee.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const env: Record<string, string | undefined> = {};
const inserted: unknown[] = [];

function fakeDb() {
  const chain = {
    values: (v: unknown) => {
      inserted.push(v);
      return { onConflictDoUpdate: async () => undefined };
    },
  };
  return { insert: () => chain } as unknown;
}

vi.mock("@/lib/cloudflare", () => ({
  getCloudflareEnv: () => env,
  getCloudflareDb: () => fakeDb(),
}));
vi.mock("@/lib/logger", () => ({ logError: vi.fn(async () => undefined) }));
// No session: the /api/admin route must decide on the key alone.
vi.mock("@/lib/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth")>()),
  auth: async () => null,
}));

const CANARY = "c".repeat(64);
const INTERNAL = "i".repeat(64);
const ctx = { params: Promise.resolve({}) } as never;

const post = (
  path: string,
  key: string | null,
  body: unknown = { ok: true, profile: "mobile-safari", checks: 3 }
) =>
  new NextRequest(`https://meetmeatthefair.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "x-internal-key": key } : {}) },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  for (const k of Object.keys(env)) delete env[k];
  env.INTERNAL_API_KEY = INTERNAL;
  env.CANARY_STAMP_KEY = CANARY;
  inserted.length = 0;
});

describe("funnel-canary stamp key (OPE-363)", () => {
  it("CANARY_STAMP_KEY stamps a kind='canary' row on the canary route", async () => {
    const { POST } = await import("../route");
    const res = await POST(post("/api/internal/funnel-canary", CANARY), ctx);
    expect(res.status).toBe(200);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ agentCode: "canary:funnel", kind: "canary" });
  });

  it("INTERNAL_API_KEY still works on the canary route", async () => {
    const { POST } = await import("../route");
    expect((await POST(post("/api/internal/funnel-canary", INTERNAL), ctx)).status).toBe(200);
  });

  it("a wrong key, no key, and an UNSET canary key are all refused (nothing stamped)", async () => {
    const { POST } = await import("../route");
    expect((await POST(post("/api/internal/funnel-canary", "nope"), ctx)).status).toBe(401);
    expect((await POST(post("/api/internal/funnel-canary", null), ctx)).status).toBe(401);
    env.CANARY_STAMP_KEY = "";
    expect((await POST(post("/api/internal/funnel-canary", CANARY), ctx)).status).toBe(401);
    expect(inserted).toHaveLength(0);
  });

  it("is REFUSED on another /api/internal route", async () => {
    const { POST } = await import("@/app/api/internal/cpi/record-filing/route");
    // Landmark: the same route ACCEPTS the internal key's auth gate (it then
    // validates the body, so anything but 401 proves the gate opened).
    const withInternal = await POST(post("/api/internal/cpi/record-filing", INTERNAL, {}), ctx);
    expect(withInternal.status).not.toBe(401);
    const withCanary = await POST(post("/api/internal/cpi/record-filing", CANARY, {}), ctx);
    expect(withCanary.status).toBe(401);
  });

  it("is REFUSED on an /api/admin route that accepts the internal key", async () => {
    const { POST } = await import("@/app/api/admin/newsletter/send/route");
    const withInternal = await POST(post("/api/admin/newsletter/send", INTERNAL, {}), ctx);
    expect(withInternal.status).not.toBe(401); // landmark: the internal key opens this gate
    const withCanary = await POST(post("/api/admin/newsletter/send", CANARY, {}), ctx);
    expect(withCanary.status).toBe(401);
  });
});
