/**
 * OPE-1391 (LIB3) — POST /register is capped per IP on the REAL BurstCounter
 * Durable Object, and a dynamically registered client still carries the
 * library's 90-day, renew-on-use registration TTL (pinned, not changed).
 */
import { describe, it, expect } from "vitest";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { env as workerEnv } from "cloudflare:workers";
import { mcpOAuthProviderOptions } from "../src/oauth/provider-options";
import { LoginHandler } from "../src/oauth/login-handler";
import {
  guardClientRegistration,
  REGISTER_IP_LIMIT,
  REGISTER_PERIOD_SECONDS,
} from "../src/oauth/register-throttle";
import type { WorkerdTestEnv } from "./env.js";

const env = workerEnv as unknown as WorkerdTestEnv;
const ORIGIN = "https://mcp.meetmeatthefair.com";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

const api = { fetch: async () => new Response("api") };
const provider = new OAuthProvider(
  mcpOAuthProviderOptions({ mcp: api, sse: api, login: LoginHandler as never })
);
const ctx = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

let ipSeq = 0;
const freshIp = () => `198.51.100.${++ipSeq}`;

function registerRequest(ip: string, method = "POST", path = "/register") {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    ...(method === "POST"
      ? {
          body: JSON.stringify({
            client_name: "claude.ai",
            redirect_uris: [REDIRECT],
            token_endpoint_auth_method: "none",
          }),
        }
      : {}),
  });
}

/** What the Worker's fetch does: the guard, then the provider. */
async function worker(request: Request): Promise<Response> {
  const refused = await guardClientRegistration(request, env as never);
  return refused ?? provider.fetch(request, { OAUTH_KV: env.OAUTH_KV, DB: env.DB } as never, ctx);
}

describe("OPE-1391 — POST /register per-IP throttle", () => {
  it(`allows ${REGISTER_IP_LIMIT} registrations an hour from one IP, refuses the next with 429 + Retry-After`, async () => {
    const ip = freshIp();
    for (let i = 0; i < REGISTER_IP_LIMIT; i++) {
      const res = await worker(registerRequest(ip));
      expect(res.status).toBe(201);
    }
    const over = await worker(registerRequest(ip));
    expect(over.status).toBe(429);
    const retry = Number(over.headers.get("Retry-After"));
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(REGISTER_PERIOD_SECONDS);
    expect(((await over.json()) as { error: string }).error).toBe("too_many_requests");
  });

  it("another IP in the same window still registers", async () => {
    const ip = freshIp();
    for (let i = 0; i <= REGISTER_IP_LIMIT; i++) await worker(registerRequest(ip));
    expect((await worker(registerRequest(freshIp()))).status).toBe(201);
  });

  it("only POST /register is counted", async () => {
    const ip = freshIp();
    for (let i = 0; i < REGISTER_IP_LIMIT * 2; i++) {
      expect(
        await guardClientRegistration(registerRequest(ip, "GET", "/register"), env as never)
      ).toBeNull();
      expect(
        await guardClientRegistration(registerRequest(ip, "POST", "/token"), env as never)
      ).toBeNull();
    }
    expect((await worker(registerRequest(ip))).status).toBe(201);
  });

  it("no BURST_COUNTER binding → refused (a broken deploy must not run unthrottled)", async () => {
    const res = await guardClientRegistration(registerRequest(freshIp()), { DB: env.DB });
    expect(res?.status).toBe(429);
  });
});

describe("OPE-1391 — registration lifetime (library default, pinned)", () => {
  it("a DCR client record expires ~90 days out (clientRegistrationTTL not disabled)", async () => {
    const res = await worker(registerRequest(freshIp()));
    expect(res.status).toBe(201);
    const { client_id } = (await res.json()) as { client_id: string };
    const listed = await env.OAUTH_KV.list({ prefix: `client:${client_id}` });
    expect(listed.keys).toHaveLength(1);
    const expiration = listed.keys[0].expiration;
    expect(expiration).toBeDefined();
    const days = (expiration! - Date.now() / 1000) / 86400;
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThanOrEqual(90);
  });
});
