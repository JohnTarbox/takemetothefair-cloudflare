/**
 * OPE-1391 — wiring guard. The behaviour is proven in workerd
 * (workerd-tests/mcp-session-binding.test.ts, register-throttle.test.ts); this
 * pins that the shipped entry (src/index.ts, which node cannot import — it pulls
 * in the Durable Object stack) actually USES it:
 *   - EVERY McpAgent serve() / serveSSE() handler handed to the OAuth provider is
 *     wrapped in bindMcpSessionsToUser (an unwrapped /sse would reopen the hole
 *     with a client-chosen ?sessionId);
 *   - the /register guard runs before oauthProvider.fetch.
 * Anchored on call syntax, not bare symbols, so the import lines cannot satisfy it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(resolve(__dirname, "../src/index.ts"), "utf8");

describe("OPE-1391 — src/index.ts wiring", () => {
  it("every MeetMeAtTheFairMCP.serve/serveSSE call is wrapped in bindMcpSessionsToUser", () => {
    const serveCalls = src.match(/MeetMeAtTheFairMCP\.serve(SSE)?\(/g) ?? [];
    const wrapped = src.match(/bindMcpSessionsToUser\(\s*MeetMeAtTheFairMCP\.serve(SSE)?\(/g) ?? [];
    expect(serveCalls.length).toBeGreaterThanOrEqual(2);
    expect(wrapped.length).toBe(serveCalls.length);
    expect(src).toMatch(/bindMcpSessionsToUser\(\s*MeetMeAtTheFairMCP\.serveSSE\("\/sse"\)\)/);
    expect(src).toMatch(/bindMcpSessionsToUser\(\s*MeetMeAtTheFairMCP\.serve\("\/mcp"\)\)/);
  });

  it("the /register guard runs before the OAuth provider sees the request", () => {
    const guard = src.indexOf("await guardClientRegistration(request, env)");
    const provider = src.indexOf("await oauthProvider.fetch(request, env, ctx)");
    expect(guard).toBeGreaterThan(-1);
    expect(provider).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(provider);
    expect(src.slice(guard, provider)).toMatch(
      /if \(registrationRefused\) return registrationRefused;/
    );
  });
});
