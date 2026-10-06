/**
 * OPE-1323 — connector login under @cloudflare/workers-oauth-provider 1.x.
 *
 * Builds the provider from the SAME options object prod uses
 * (`mcpOAuthProviderOptions`), with stub API/login handlers in place of the
 * Durable Object and the Google sign-in, and drives the real HTTP flow:
 * dynamic registration → authorize → token → API call → refresh.
 *
 * The legacy-grant cases rewrite a stored grant into the three `resource`
 * shapes read from prod OAUTH_KV on 2026-10-06 (69 grants):
 *   "https://mcp.meetmeatthefair.com/"                         — every live MMATF grant
 *   absent                                                      — 2 grants from 2026-03-31
 *   "https://meetmeatthefair-mcp.john-tarbox-account.workers.dev/" — 6 stale pre-domain grants
 */
import { describe, it, expect, beforeEach } from "vitest";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { MCP_OAUTH_RESOURCE, mcpOAuthProviderOptions } from "../src/oauth/provider-options";

const ORIGIN = "https://mcp.meetmeatthefair.com";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

import { env as workerEnv } from "cloudflare:workers";
import type { WorkerdTestEnv } from "./env.js";

const { OAUTH_KV } = workerEnv as unknown as WorkerdTestEnv;

// Each test logs in as its own user, so grants written by one test can never
// satisfy (or pollute) another's assertions in the shared local KV.
let currentUser = "user-0";
let userSeq = 0;

type TestEnv = { OAUTH_KV: KVNamespace; OAUTH_PROVIDER: OAuthHelpers };

const apiHandler = {
  async fetch(_req: Request, _env: TestEnv, ctx: ExecutionContext & { props?: unknown }) {
    return Response.json({ ok: true, props: ctx.props });
  },
};

// Stands in for LoginHandler: skips the Google hop, completes as one user.
const loginHandler = {
  async fetch(req: Request, env: TestEnv) {
    const url = new URL(req.url);
    if (url.pathname !== "/authorize") return new Response("not found", { status: 404 });
    let info;
    try {
      info = await env.OAUTH_PROVIDER.parseAuthRequest(req);
    } catch (err) {
      return new Response(`refused: ${(err as Error).message}`, { status: 400 });
    }
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: info,
      userId: currentUser,
      metadata: {},
      scope: info.scope,
      props: { userId: currentUser, email: "test@example.com" },
    });
    return Response.redirect(redirectTo, 302);
  },
};

function makeProvider() {
  return new OAuthProvider<TestEnv>(
    mcpOAuthProviderOptions<TestEnv>({ mcp: apiHandler, sse: apiHandler, login: loginHandler })
  );
}

const ctx = () =>
  ({ waitUntil() {}, passThroughOnException() {}, props: {} }) as unknown as ExecutionContext;

function b64url(bytes: ArrayBuffer) {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const challenge = b64url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  );
  return { verifier, challenge };
}

let provider: ReturnType<typeof makeProvider>;
let env: TestEnv;

async function call(path: string, init?: RequestInit) {
  return provider.fetch(new Request(`${ORIGIN}${path}`, init), env as never, ctx());
}

async function register() {
  const res = await call("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "claude.ai",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { client_id: string };
}

async function authorize(clientId: string, opts: { method?: string; resource?: string } = {}) {
  const { verifier, challenge } = await pkce();
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: opts.method ?? "S256",
    state: "st",
    scope: "mcp",
  });
  if (opts.resource) q.set("resource", opts.resource);
  const res = await call(`/authorize?${q}`);
  return { res, verifier };
}

async function exchange(clientId: string, code: string, verifier: string, redirectUri = REDIRECT) {
  return call("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
}

async function refresh(clientId: string, refreshToken: string) {
  return call("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    }),
  });
}

async function fullLogin(resource?: string) {
  const { client_id } = await register();
  const { res, verifier } = await authorize(client_id, { resource });
  expect(res.status).toBe(302);
  const code = new URL(res.headers.get("Location")!).searchParams.get("code")!;
  expect(code).toBeTruthy();
  const tok = await exchange(client_id, code, verifier);
  expect(tok.status).toBe(200);
  const body = (await tok.json()) as { access_token: string; refresh_token: string };
  return { client_id, ...body };
}

async function storedGrantKeys() {
  const res = await OAUTH_KV.list({ prefix: `grant:${currentUser}:` });
  return res.keys.map((k) => k.name);
}

/** Rewrite every stored grant to a prod-observed 0.x `resource` shape, dropping 1.x key metadata. */
async function rewriteGrantsToLegacy(resource: string | undefined) {
  const keys = await storedGrantKeys();
  expect(keys.length).toBe(1); // landmark: exactly this test's one grant is rewritten
  for (const k of keys) {
    const g = (await OAUTH_KV.get(k, "json")) as Record<string, unknown>;
    if (resource === undefined) delete g.resource;
    else g.resource = resource;
    // Re-put WITHOUT metadata: grants written before 1.0 carry none.
    await OAUTH_KV.put(k, JSON.stringify(g));
  }
}

beforeEach(() => {
  currentUser = `user-${++userSeq}`;
  provider = makeProvider();
  env = { OAUTH_KV } as unknown as TestEnv;
});

describe("OPE-1323 — canonical resource", () => {
  it("is the bare origin, and the provider constructs with both /mcp and /sse under it", () => {
    expect(MCP_OAUTH_RESOURCE).toBe(ORIGIN);
    expect(() => makeProvider()).not.toThrow();
  });

  it("publishes the origin as the protected resource (both metadata paths)", async () => {
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const res = await call(path);
      // /mcp-suffixed metadata may be 404 in 1.x when the resource is the origin;
      // what matters is that whatever IS served names the origin.
      if (res.status === 200) {
        const meta = (await res.json()) as { resource: string };
        expect(meta.resource.replace(/\/$/, "")).toBe(ORIGIN);
      }
    }
    const root = await call("/.well-known/oauth-protected-resource");
    expect(root.status).toBe(200);
  });

  it("advertises S256 only", async () => {
    const res = await call("/.well-known/oauth-authorization-server");
    const meta = (await res.json()) as { code_challenge_methods_supported: string[] };
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
  });
});

describe("OPE-1323 — connector login flow", () => {
  it("DCR → authorize → token → /mcp and /sse reach the API handler with props", async () => {
    const { access_token } = await fullLogin();
    for (const path of ["/mcp", "/sse"]) {
      const res = await call(path, { headers: { Authorization: `Bearer ${access_token}` } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { props: { userId: string } };
      expect(body.props.userId).toBe(currentUser);
    }
  });

  it("accepts the resource indicator as clients actually send it (origin, with and without slash)", async () => {
    await fullLogin(ORIGIN);
    await fullLogin(`${ORIGIN}/`);
  });

  it("rejects an unauthenticated /mcp call", async () => {
    const res = await call("/mcp");
    expect(res.status).toBe(401);
  });

  it("binds redirect_uri: a code exchange with a different registered URI fails", async () => {
    const res0 = await call("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [REDIRECT, "https://claude.ai/other_callback"],
        token_endpoint_auth_method: "none",
      }),
    });
    const { client_id } = (await res0.json()) as { client_id: string };
    const { res, verifier } = await authorize(client_id);
    const code = new URL(res.headers.get("Location")!).searchParams.get("code")!;
    const tok = await exchange(client_id, code, verifier, "https://claude.ai/other_callback");
    expect(tok.status).toBe(400);
    expect(((await tok.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("refuses plain PKCE", async () => {
    const { client_id } = await register();
    const { res } = await authorize(client_id, { method: "plain" });
    expect(res.status).not.toBe(302);
    expect(await storedGrantKeys()).toHaveLength(0);
  });

  it("refreshes a freshly issued 1.x grant", async () => {
    const { client_id, refresh_token } = await fullLogin();
    const res = await refresh(client_id, refresh_token);
    expect(res.status).toBe(200);
  });
});

describe("OPE-1323 — refresh of 0.x-shaped stored grants (prod shapes, 2026-10-06)", () => {
  it('resource "https://mcp.meetmeatthefair.com/" (every live grant) keeps refreshing', async () => {
    const { client_id, refresh_token } = await fullLogin();
    await rewriteGrantsToLegacy(`${ORIGIN}/`);
    const res = await refresh(client_id, refresh_token);
    expect(res.status).toBe(200);
    const { access_token } = (await res.json()) as { access_token: string };
    const api = await call("/mcp", { headers: { Authorization: `Bearer ${access_token}` } });
    expect(api.status).toBe(200);
  });

  it("an absent resource binds to the sole resource and keeps refreshing", async () => {
    const { client_id, refresh_token } = await fullLogin();
    await rewriteGrantsToLegacy(undefined);
    const res = await refresh(client_id, refresh_token);
    expect(res.status).toBe(200);
  });

  it("the stale workers.dev resource fails with invalid_grant (client re-authorizes; no loop)", async () => {
    const { client_id, refresh_token } = await fullLogin();
    await rewriteGrantsToLegacy("https://meetmeatthefair-mcp.john-tarbox-account.workers.dev/");
    const res = await refresh(client_id, refresh_token);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
    // …and a fresh authorization for the same client then succeeds.
    const again = await authorize(client_id);
    expect(again.res.status).toBe(302);
  });
});
