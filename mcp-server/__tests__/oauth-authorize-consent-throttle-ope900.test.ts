/**
 * OPE-900 steps 2 and 4 — the MCP sign-in page names what is being authorized,
 * can be refused, and throttles password guessing.
 *
 * Acceptance, literally:
 *  - "authorize shows a page naming the client and redirect host. Deny → the
 *     redirect receives error=access_denied."
 *  - "Six wrong passwords within 60 s from one IP → the 6th gets 429. The
 *     correct password from a different IP in the same window → success."
 *
 * The counter is a fake namespace over the REAL window arithmetic
 * (`decideBurstHit`), so the 6th-is-429 boundary is the Worker's own.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { LoginHandler } from "../src/oauth/login-handler.js";
import { makeFakeBurstCounter } from "./_mocks/fake-burst-counter.js";

vi.mock("../src/logger.js", () => ({ logError: async () => {} }));
vi.mock("../src/db.js", () => ({ getDb: () => ({}) }));

const verifyPassword = vi.fn(async (password: string) => password === "correct-horse");
vi.mock("../src/oauth/utils.js", () => ({
  lookupUser: async (_db: unknown, email: string) =>
    email === "john@example.com"
      ? { id: "u1", email, passwordHash: "stored", role: "ADMIN" }
      : null,
  verifyPassword: (p: string) => verifyPassword(p),
  resolveUserProps: async () => ({ userId: "u1" }),
  isLegacyPasswordHash: () => false,
  upgradePasswordHash: async () => {},
}));

const completeAuthorization = vi.fn(async () => ({
  redirectTo: "https://claude.ai/api/mcp/auth_callback?code=REAL",
}));

const AUTH_REQ = {
  clientId: "client-abc",
  redirectUri: "https://claude.ai/api/mcp/auth_callback",
  scope: ["read"],
  state: "client-state-xyz",
};

function makeKv() {
  const store = new Map<string, string>();
  return {
    store,
    put: vi.fn(async (k: string, v: string) => void store.set(k, v)),
    get: vi.fn(async (k: string) => (store.has(k) ? store.get(k)! : null)),
    delete: vi.fn(async (k: string) => void store.delete(k)),
  };
}

let kv: ReturnType<typeof makeKv>;
let counter: ReturnType<typeof makeFakeBurstCounter>;
let client: Record<string, unknown> | null;
let env: Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  kv = makeKv();
  counter = makeFakeBurstCounter();
  client = {
    clientId: "client-abc",
    clientName: "Claude",
    clientUri: "https://claude.ai",
    redirectUris: [AUTH_REQ.redirectUri],
  };
  env = {
    DB: {},
    OAUTH_KV: kv,
    OAUTH_PROVIDER: {
      parseAuthRequest: async () => AUTH_REQ,
      lookupClient: async () => client,
      completeAuthorization,
    },
    BURST_COUNTER: counter.ns,
  };
});

async function beginLogin() {
  const res = await LoginHandler.request("/authorize?client_id=client-abc", {}, env);
  const html = await res.text();
  return {
    res,
    html,
    stateId: /name="state" value="([^"]+)"/.exec(html)?.[1] ?? "",
    csrf: /name="csrf_token" value="([^"]+)"/.exec(html)?.[1] ?? "",
  };
}

function post(body: Record<string, string>, csrf: string, ip = "203.0.113.7") {
  return LoginHandler.request(
    "/authorize",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `__Host-CSRF=${csrf}`,
        "CF-Connecting-IP": ip,
      },
      body: new URLSearchParams(body).toString(),
    },
    env
  );
}

/** A login attempt with a fresh state + CSRF, the way a real browser retry is. */
async function attempt(password: string, ip = "203.0.113.7", email = "john@example.com") {
  const { stateId, csrf } = await beginLogin();
  return post({ csrf_token: csrf, email, password, state: stateId }, csrf, ip);
}

describe("step 2 — consent", () => {
  it("names the client AND the redirect host it will send the user back to", async () => {
    const { res, html } = await beginLogin();
    expect(res.status).toBe(200);
    expect(html).toContain("<strong>Claude</strong> is requesting access");
    expect(html).toContain("claude.ai"); // redirect host
    expect(html).toMatch(/name="action" value="deny"/);
    // The old page hard-coded "Claude" for every client; it must come from the registration.
    client = { ...client, clientName: "Some Other App" };
    expect((await beginLogin()).html).toContain("<strong>Some Other App</strong>");
  });

  it("escapes a hostile self-registered client name", async () => {
    client = { ...client, clientName: '<img src=x onerror="alert(1)">' };
    const { html } = await beginLogin();
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("an unknown client gets 400 and no state is minted", async () => {
    client = null;
    const { res } = await beginLogin();
    expect(res.status).toBe(400);
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("Deny → 302 to the client's redirect with error=access_denied and its state; nothing authorized", async () => {
    const { stateId, csrf } = await beginLogin();
    const res = await post({ csrf_token: csrf, state: stateId, action: "deny" }, csrf);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(`${loc.origin}${loc.pathname}`).toBe(AUTH_REQ.redirectUri);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("state")).toBe("client-state-xyz");
    expect(completeAuthorization).not.toHaveBeenCalled();
    expect(kv.store.has(`login:state:${stateId}`)).toBe(false); // burned
  });

  it("Deny still requires the CSRF cookie — a third party cannot refuse on the user's behalf", async () => {
    const { stateId, csrf } = await beginLogin();
    const res = await post({ csrf_token: csrf, state: stateId, action: "deny" }, "wrong-cookie");
    expect(res.status).toBe(403);
    expect(kv.store.has(`login:state:${stateId}`)).toBe(true);
  });

  it("LANDMARK: Approve with the right password still completes", async () => {
    const res = await attempt("correct-horse");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("code=REAL");
  });
});

describe("step 4 — throttle", () => {
  it("ACCEPTANCE: six wrong passwords from one IP → the 6th is 429 with Retry-After", async () => {
    for (let i = 1; i <= 5; i++) expect((await attempt("wrong", "198.51.100.1")).status).toBe(200);
    const sixth = await attempt("wrong", "198.51.100.1");
    expect(sixth.status).toBe(429);
    const retry = Number(sixth.headers.get("Retry-After"));
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(60);
    expect(await sixth.text()).toContain("Too many sign-in attempts");
  });

  it("the password is never checked once refused — the throttle runs BEFORE verifyPassword", async () => {
    for (let i = 0; i < 6; i++) await attempt("wrong", "198.51.100.1");
    expect(verifyPassword).toHaveBeenCalledTimes(5);
  });

  it("ACCEPTANCE: the correct password from a DIFFERENT IP in the same window succeeds", async () => {
    for (let i = 0; i < 6; i++) await attempt("wrong", "198.51.100.1");
    const res = await attempt("correct-horse", "192.0.2.50");
    expect(res.status).toBe(302);
    expect(completeAuthorization).toHaveBeenCalledTimes(1);
  });

  it("the ACCOUNT is capped too: rotating IPs stop at 10 attempts on one email", async () => {
    for (let i = 1; i <= 10; i++) {
      expect((await attempt("wrong", `10.0.0.${i}`)).status).toBe(200);
    }
    const eleventh = await attempt("wrong", "10.0.0.99");
    expect(eleventh.status).toBe(429);
    // …while a different account from a fresh IP is untouched.
    expect((await attempt("wrong", "10.0.1.1", "someone@example.com")).status).toBe(200);
  });

  it("a refused attempt does not burn the state — the same page works after the wait", async () => {
    for (let i = 0; i < 5; i++) await attempt("wrong", "198.51.100.1");
    const { stateId, csrf } = await beginLogin();
    const refused = await post(
      { csrf_token: csrf, email: "john@example.com", password: "correct-horse", state: stateId },
      csrf,
      "198.51.100.1"
    );
    expect(refused.status).toBe(429);
    expect(kv.store.has(`login:state:${stateId}`)).toBe(true);
  });

  it("no counter binding → refuse (fail closed), and the password is never checked", async () => {
    delete env.BURST_COUNTER;
    const res = await attempt("correct-horse");
    expect(res.status).toBe(429);
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  it("the counter THROWING allows the attempt — a DO incident must not lock everyone out", async () => {
    env.BURST_COUNTER = {
      idFromName: (n: string) => n,
      get: () => ({
        hit: async () => {
          throw new Error("DO overloaded");
        },
      }),
    };
    const res = await attempt("correct-horse");
    expect(res.status).toBe(302);
  });

  it("hits both keys with their own budgets, and the email never appears in a key", async () => {
    await attempt("wrong", "198.51.100.1");
    const byKey = Object.fromEntries(counter.hits.map((h) => [h.key.split(":")[2], h]));
    expect(byKey.ip).toMatchObject({ limit: 5, periodSeconds: 60 });
    expect(byKey.email).toMatchObject({ limit: 10, periodSeconds: 60 });
    expect(counter.hits.map((h) => h.key).join()).not.toContain("john@example.com");
  });
});
