/**
 * OPE-1371 (HARD4) — in the real runtime, through the REAL provider options and
 * the REAL LoginHandler: the consent page served for a dynamically registered
 * client carries the anti-framing headers, and its form-action admits the
 * client's redirect origin.
 */
import { describe, it, expect } from "vitest";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { env as workerEnv } from "cloudflare:workers";
import { mcpOAuthProviderOptions } from "../src/oauth/provider-options";
import { LoginHandler } from "../src/oauth/login-handler";
import type { WorkerdTestEnv } from "./env.js";

const ORIGIN = "https://mcp.meetmeatthefair.com";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const { OAUTH_KV, DB } = workerEnv as unknown as WorkerdTestEnv;

const api = { fetch: async () => new Response("api") };
const provider = new OAuthProvider(
  mcpOAuthProviderOptions({ mcp: api, sse: api, login: LoginHandler as never })
);
const ctx = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;
const call = (path: string, init?: RequestInit) =>
  provider.fetch(new Request(`${ORIGIN}${path}`, init), { OAUTH_KV, DB } as never, ctx);

describe("OPE-1371 — consent page headers (workerd, real LoginHandler)", () => {
  it("GET /authorize is not frameable and still renders the form", async () => {
    const reg = await call("/register", {
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
    expect(reg.status).toBe(201);
    const { client_id } = (await reg.json()) as { client_id: string };

    const q = new URLSearchParams({
      response_type: "code",
      client_id,
      redirect_uri: REDIRECT,
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      state: "st",
      scope: "mcp",
    });
    const res = await call(`/authorize?${q}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('action="/authorize"');
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self' https://claude.ai");
  });

  it("a rejected authorize request (unknown client) is not frameable either", async () => {
    const res = await call("/authorize?response_type=code&client_id=nope&redirect_uri=x");
    expect(res.status).toBe(400);
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });
});
