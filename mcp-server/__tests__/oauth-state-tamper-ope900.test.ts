/**
 * OPE-900 — the login form's `state` must not be forgeable.
 *
 * Before this, GET /authorize rendered the whole authorization request into the
 * form as `btoa(JSON.stringify(oauthReqInfo))` and POST /authorize trusted it
 * back verbatim. Nothing signed it, so a client could rewrite any field — and
 * `redirectUri` is the field `completeAuthorization` uses to decide where the
 * auth code goes. Rewriting it redirects somebody else's code to an attacker.
 *
 * The request now lives in KV under an opaque random id. These tests pin the
 * property that matters: **the POST body cannot introduce an authorization
 * request the server did not mint.**
 *
 * Every refusal case below is paired with a positive landmark, because a
 * handler that 400s on everything would satisfy the refusals alone.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { LoginHandler } from "../src/oauth/login-handler.js";

vi.mock("../src/logger.js", () => ({ logError: async () => {} }));
vi.mock("../src/db.js", () => ({ getDb: () => ({}) }));

const completeAuthorization = vi.fn(async () => ({
  redirectTo: "https://claude.ai/api/mcp/auth_callback?code=REAL",
}));

vi.mock("../src/oauth/utils.js", () => ({
  lookupUser: async (_db: unknown, email: string) =>
    email === "john@example.com"
      ? { id: "u1", email, passwordHash: "stored", role: "ADMIN" }
      : null,
  verifyPassword: async (password: string) => password === "correct-horse",
  resolveUserProps: async () => ({ userId: "u1" }),
  // OPE-902 added a legacy-hash upgrade to the success path; this mock has to
  // grow with it or the "authorization completes" cases throw instead of
  // asserting. Reporting `false` keeps this file about state tampering.
  isLegacyPasswordHash: () => false,
  upgradePasswordHash: async () => {},
}));

/** Minimal KV double — enough to hold, expire and delete a pending state. */
function makeKv() {
  const store = new Map<string, string>();
  return {
    store,
    put: vi.fn(async (k: string, v: string) => void store.set(k, v)),
    get: vi.fn(async (k: string) => (store.has(k) ? store.get(k)! : null)),
    delete: vi.fn(async (k: string) => void store.delete(k)),
  };
}

const AUTH_REQ = {
  clientId: "client-abc",
  redirectUri: "https://claude.ai/api/mcp/auth_callback",
  scope: ["read"],
  state: "opaque",
};

let kv: ReturnType<typeof makeKv>;
let env: Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  kv = makeKv();
  env = {
    DB: {},
    OAUTH_KV: kv,
    OAUTH_PROVIDER: {
      parseAuthRequest: async () => AUTH_REQ,
      completeAuthorization,
    },
  };
});

/** Drive GET /authorize and return the state id it minted, plus the CSRF token. */
async function beginLogin() {
  const res = await LoginHandler.request("/authorize?client_id=client-abc", {}, env);
  expect(res.status).toBe(200);
  const html = await res.text();
  const stateId = /name="state" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const csrf = /name="csrf_token" value="([^"]+)"/.exec(html)?.[1] ?? "";
  return { stateId, csrf };
}

function post(body: Record<string, string>, csrf: string) {
  const form = new URLSearchParams(body);
  return LoginHandler.request(
    "/authorize",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `__Host-CSRF=${csrf}`,
      },
      body: form.toString(),
    },
    env
  );
}

describe("GET /authorize hands out an opaque id, not the request", () => {
  it("stores the authorization request server-side under that id", async () => {
    const { stateId } = await beginLogin();
    expect(stateId).toMatch(/^[0-9a-f-]{36}$/);
    expect(kv.store.get(`login:state:${stateId}`)).toBe(JSON.stringify(AUTH_REQ));
  });

  it("does NOT put the redirect URI anywhere in the rendered form", async () => {
    const res = await LoginHandler.request("/authorize?client_id=client-abc", {}, env);
    const html = await res.text();
    // The old implementation base64'd the whole request into the page, so the
    // decoded redirectUri travelled to the browser and back.
    expect(html).not.toContain(btoa(JSON.stringify(AUTH_REQ)));
  });
});

describe("POST /authorize refuses anything it did not mint", () => {
  it("400s on a state id that was never issued", async () => {
    const { csrf } = await beginLogin();
    const res = await post(
      {
        csrf_token: csrf,
        email: "john@example.com",
        password: "correct-horse",
        state: "11111111-2222-3333-4444-555555555555",
      },
      csrf
    );
    expect(res.status).toBe(400);
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  it("400s when a single character of a real id is altered", async () => {
    const { stateId, csrf } = await beginLogin();
    const tampered = stateId.slice(0, -1) + (stateId.endsWith("a") ? "b" : "a");
    expect(tampered).not.toBe(stateId);
    const res = await post(
      { csrf_token: csrf, email: "john@example.com", password: "correct-horse", state: tampered },
      csrf
    );
    expect(res.status).toBe(400);
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  it("400s on a forged base64 request — the old format is no longer accepted", async () => {
    const { csrf } = await beginLogin();
    const forged = btoa(
      JSON.stringify({ ...AUTH_REQ, redirectUri: "https://attacker.example/steal" })
    );
    const res = await post(
      { csrf_token: csrf, email: "john@example.com", password: "correct-horse", state: forged },
      csrf
    );
    expect(res.status).toBe(400);
    // The whole point: the attacker's redirect never reaches the provider.
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  it("400s once the stored state has expired out of KV", async () => {
    const { stateId, csrf } = await beginLogin();
    kv.store.delete(`login:state:${stateId}`); // what a TTL expiry looks like
    const res = await post(
      { csrf_token: csrf, email: "john@example.com", password: "correct-horse", state: stateId },
      csrf
    );
    expect(res.status).toBe(400);
    expect(completeAuthorization).not.toHaveBeenCalled();
  });
});

describe("the positive landmarks — a handler that only refused would fail these", () => {
  it("completes the authorization with the STORED request, not the posted one", async () => {
    const { stateId, csrf } = await beginLogin();
    const res = await post(
      { csrf_token: csrf, email: "john@example.com", password: "correct-horse", state: stateId },
      csrf
    );
    expect(res.status).toBe(302);
    expect(completeAuthorization).toHaveBeenCalledTimes(1);
    const arg = completeAuthorization.mock.calls[0][0] as { request: typeof AUTH_REQ };
    expect(arg.request.redirectUri).toBe("https://claude.ai/api/mcp/auth_callback");
    expect(res.headers.get("Location")).toContain("code=REAL");
  });

  it("burns the id after use, so a replay cannot mint a second code", async () => {
    const { stateId, csrf } = await beginLogin();
    await post(
      { csrf_token: csrf, email: "john@example.com", password: "correct-horse", state: stateId },
      csrf
    );
    expect(kv.store.has(`login:state:${stateId}`)).toBe(false);

    const replay = await post(
      { csrf_token: csrf, email: "john@example.com", password: "correct-horse", state: stateId },
      csrf
    );
    expect(replay.status).toBe(400);
    expect(completeAuthorization).toHaveBeenCalledTimes(1);
  });

  it("a wrong password does NOT burn the id — the user can try again", async () => {
    const { stateId, csrf } = await beginLogin();
    const bad = await post(
      { csrf_token: csrf, email: "john@example.com", password: "wrong", state: stateId },
      csrf
    );
    expect(bad.status).toBe(200); // re-rendered form, not a dead end
    expect(kv.store.has(`login:state:${stateId}`)).toBe(true);
    expect(completeAuthorization).not.toHaveBeenCalled();
  });
});
