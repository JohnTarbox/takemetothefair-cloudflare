/**
 * OPE-1371 (HARD4) — the MCP OAuth sign-in/consent page must not be frameable,
 * and its CSP must still let the form POST's 302 reach the client's redirect
 * origin (browsers enforce form-action on that redirect).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { LoginHandler } from "../src/oauth/login-handler.js";
import {
  htmlContentSecurityPolicy,
  redirectFormActionSource,
  withHtmlSecurityHeaders,
} from "../src/oauth/html-security-headers.js";
import { makeFakeBurstCounter } from "./_mocks/fake-burst-counter.js";

vi.mock("../src/logger.js", () => ({ logError: async () => {} }));
vi.mock("../src/db.js", () => ({ getDb: () => ({}) }));
vi.mock("../src/oauth/utils.js", () => ({
  lookupUser: async (_db: unknown, email: string) =>
    email === "john@example.com"
      ? { id: "u1", email, passwordHash: "stored", role: "ADMIN" }
      : null,
  verifyPassword: async (p: string) => p === "correct-horse",
  resolveUserProps: async () => ({ userId: "u1" }),
}));

let redirectUri = "https://claude.ai/api/mcp/auth_callback";
let env: Record<string, unknown>;
const kvStore = new Map<string, string>();

beforeEach(() => {
  redirectUri = "https://claude.ai/api/mcp/auth_callback";
  kvStore.clear();
  env = {
    DB: {},
    OAUTH_KV: {
      put: async (k: string, v: string) => void kvStore.set(k, v),
      get: async (k: string) => kvStore.get(k) ?? null,
      delete: async (k: string) => void kvStore.delete(k),
    },
    OAUTH_PROVIDER: {
      parseAuthRequest: async () => ({
        clientId: "client-abc",
        redirectUri,
        scope: ["read"],
        state: "s",
      }),
      lookupClient: async () => ({ clientId: "client-abc", clientName: "Claude" }),
      completeAuthorization: async () => ({ redirectTo: `${redirectUri}?code=REAL` }),
    },
    BURST_COUNTER: makeFakeBurstCounter().ns,
  };
});

function expectNotFrameable(res: Response) {
  expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  const csp = res.headers.get("Content-Security-Policy") ?? "";
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("base-uri 'none'");
  expect(csp).toContain("default-src 'self'");
  return csp;
}

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

function post(body: Record<string, string>, csrf: string) {
  return LoginHandler.request(
    "/authorize",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `__Host-CSRF=${csrf}`,
        "CF-Connecting-IP": "203.0.113.9",
      },
      body: new URLSearchParams(body).toString(),
    },
    env
  );
}

describe("OPE-1371 — the authorize page cannot be framed", () => {
  it("ACCEPTANCE: GET /authorize carries X-Frame-Options DENY + frame-ancestors 'none'", async () => {
    const { res, html } = await beginLogin();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/html/);
    expect(html).toContain("<form"); // landmark: this IS the consent page
    const csp = expectNotFrameable(res);
    // The page's only subresource is an inline <style>; it must keep rendering.
    // OPE-1380: it renders BY NONCE — the <style> carries the header's nonce.
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(html).toContain(`<style nonce="${nonce}">`);
    expect(csp).toContain(`style-src 'nonce-${nonce}'`);
    expect(csp).toContain(`script-src 'nonce-${nonce}' 'strict-dynamic'`);
    expect(csp).not.toContain("'unsafe-inline'");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    // The Set-Cookie the page always had is not displaced by the new headers.
    expect(res.headers.get("Set-Cookie")).toMatch(/^__Host-CSRF=/);
  });

  it("form-action admits the client's redirect origin, or the 302 after Approve/Deny is blocked", async () => {
    const { res } = await beginLogin();
    expect(res.headers.get("Content-Security-Policy")).toContain(
      "form-action 'self' https://claude.ai"
    );
    redirectUri = "http://localhost:33418/callback"; // desktop clients
    const local = await beginLogin();
    expect(local.res.headers.get("Content-Security-Policy")).toContain(
      "form-action 'self' http://localhost:33418"
    );
  });

  it("the re-rendered page after a wrong password is protected too", async () => {
    const { stateId, csrf } = await beginLogin();
    const res = await post(
      { csrf_token: csrf, state: stateId, email: "john@example.com", password: "nope" },
      csrf
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Invalid email or password");
    const csp = expectNotFrameable(res);
    expect(csp).toContain("form-action 'self' https://claude.ai");
    // OPE-1380 — the re-render gets its own nonce, matching its <style>.
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(html).toContain(`<style nonce="${nonce}">`);
  });

  it("OPE-1380 — the nonce is fresh on every render", async () => {
    const nonces = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const { res } = await beginLogin();
      nonces.add(
        /'nonce-([^']+)'/.exec(res.headers.get("Content-Security-Policy") ?? "")?.[1] ?? ""
      );
    }
    expect(nonces.size).toBe(4);
    expect(nonces.has("")).toBe(false);
  });

  it("OPE-1380 — a malformed nonce never reaches the header (falls back to the baseline)", () => {
    const csp = htmlContentSecurityPolicy("https://claude.ai/cb", "x'; script-src *");
    expect(csp).not.toContain("script-src *");
    expect(csp).not.toContain("nonce-");
    expect(csp).toContain("style-src 'unsafe-inline'");
  });

  it("error pages (400 bad request, 403 CSRF) and 404s get the baseline", async () => {
    (env.OAUTH_PROVIDER as Record<string, unknown>).parseAuthRequest = async () => {
      throw new Error("bad client");
    };
    const bad = await LoginHandler.request("/authorize", {}, env);
    expect(bad.status).toBe(400);
    expectNotFrameable(bad);

    const csrf = await post({ csrf_token: "a", state: "x" }, "b");
    expect(csrf.status).toBe(403);
    expectNotFrameable(csrf);

    const missing = await LoginHandler.request("/nope", {}, env);
    expect(missing.status).toBe(404);
    expectNotFrameable(missing);
  });

  it("LANDMARK: Approve still 302s to the client with a code", async () => {
    const { stateId, csrf } = await beginLogin();
    const res = await post(
      { csrf_token: csrf, state: stateId, email: "john@example.com", password: "correct-horse" },
      csrf
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("code=REAL");
  });
});

describe("redirectFormActionSource — a registered URI cannot inject directives", () => {
  it("emits normalised origins and safe schemes only", () => {
    expect(redirectFormActionSource("https://claude.ai/api/cb?x=1")).toBe("https://claude.ai");
    expect(redirectFormActionSource("http://[::1]:8080/cb")).toBe("http://[::1]:8080");
    expect(redirectFormActionSource("cursor://anysphere.cursor-mcp/cb")).toBe("cursor:");
    expect(redirectFormActionSource("javascript:alert(1)")).toBeNull();
    expect(redirectFormActionSource("data:text/html,x")).toBeNull();
    expect(redirectFormActionSource("not a url")).toBeNull();
    expect(redirectFormActionSource(undefined)).toBeNull();
  });

  it("a ';' in the URI never reaches the header as a directive", () => {
    const csp = htmlContentSecurityPolicy("https://evil.example/cb;script-src *");
    expect(csp).not.toContain("script-src *");
    expect(csp.split(";").filter((d) => d.trim().startsWith("form-action"))).toHaveLength(1);
  });

  it("withHtmlSecurityHeaders keeps a route's own CSP and handles immutable headers", async () => {
    const own = new Response("x", {
      headers: { "Content-Security-Policy": "form-action 'self' https://a.example" },
    });
    expect(withHtmlSecurityHeaders(own).headers.get("Content-Security-Policy")).toBe(
      "form-action 'self' https://a.example"
    );
    const immutable = Response.redirect("https://claude.ai/cb", 302);
    const out = withHtmlSecurityHeaders(immutable);
    expect(out.status).toBe(302);
    expect(out.headers.get("X-Frame-Options")).toBe("DENY");
  });
});
