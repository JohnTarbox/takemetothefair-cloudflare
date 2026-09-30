/**
 * OPE-1019 — the CSRF token is compared in constant time, and still works.
 *
 * Harness copied from oauth-state-tamper-ope900.test.ts. The refusal is paired
 * with a positive landmark: a handler that 403s on everything would pass the
 * refusal alone, and an `await`-less timingSafeEqualString would pass nothing
 * (a Promise is truthy, so `!promise` is always false and every token passes).
 *
 * Original OPE-900 header follows for the harness's provenance:
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
import { makeFakeBurstCounter } from "./_mocks/fake-burst-counter.js";

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
      // Step 2 added a client lookup to GET /authorize; step 4 a limiter to POST.
      lookupClient: async () => ({
        clientId: "client-abc",
        clientName: "Claude",
        redirectUris: [],
      }),
      completeAuthorization,
    },
    BURST_COUNTER: makeFakeBurstCounter().ns,
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

describe("POST /authorize CSRF check (OPE-1019)", () => {
  it("403s when the form token does not match the cookie", async () => {
    const { stateId, csrf } = await beginLogin();
    const form = new URLSearchParams({
      state: stateId,
      csrf_token: csrf.slice(0, -1) + (csrf.endsWith("0") ? "1" : "0"),
      email: "john@example.com",
      password: "correct-horse",
    });
    const res = await LoginHandler.request(
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
    expect(res.status).toBe(403);
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  it("403s when there is no CSRF cookie at all", async () => {
    const { stateId, csrf } = await beginLogin();
    const form = new URLSearchParams({
      state: stateId,
      csrf_token: csrf,
      email: "john@example.com",
      password: "correct-horse",
    });
    const res = await LoginHandler.request(
      "/authorize",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      },
      env
    );
    expect(res.status).toBe(403);
  });

  it("LANDMARK: the correct token still completes the sign-in", async () => {
    const { stateId, csrf } = await beginLogin();
    const res = await post(
      { state: stateId, csrf_token: csrf, email: "john@example.com", password: "correct-horse" },
      csrf
    );
    expect(res.status).toBe(302);
    expect(completeAuthorization).toHaveBeenCalledTimes(1);
  });
});
