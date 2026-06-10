/**
 * Tests for the Claude read-only Bearer token branch in src/lib/api-auth.ts.
 *
 * The mocking strategy mirrors the existing api-token-auth.test.ts:
 *   - vi.mock the @/lib/cloudflare module so getCloudflareEnv returns a
 *     controlled env (with or without CLAUDE_READONLY_TOKEN set).
 *   - vi.mock @/lib/auth so auth() returns null (no session) by default,
 *     letting the Bearer branch be the deciding factor.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const envState: { CLAUDE_READONLY_TOKEN?: string; INTERNAL_API_KEY?: string } = {};

vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: vi.fn(),
  getCloudflareEnv: () => envState,
}));

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => null),
}));

import {
  bearerTokenMatches,
  isAuthorized,
  getRequestIdentity,
  CLAUDE_READONLY_IDENTITY,
} from "../api-auth";

const TOKEN = "test-token-32-chars-long-enough-for";

beforeEach(() => {
  envState.CLAUDE_READONLY_TOKEN = undefined;
  envState.INTERNAL_API_KEY = undefined;
});

function reqWith(method: string, headers: Record<string, string>): Request {
  return new Request("https://example.com/admin/analytics", { method, headers });
}

describe("bearerTokenMatches", () => {
  it("returns false when env token is unset", async () => {
    expect(await bearerTokenMatches(reqWith("GET", { authorization: `Bearer ${TOKEN}` }))).toBe(
      false
    );
  });

  it("returns false when no Authorization header present", async () => {
    envState.CLAUDE_READONLY_TOKEN = TOKEN;
    expect(await bearerTokenMatches(reqWith("GET", {}))).toBe(false);
  });

  it("returns false when header is not Bearer scheme", async () => {
    envState.CLAUDE_READONLY_TOKEN = TOKEN;
    expect(await bearerTokenMatches(reqWith("GET", { authorization: `Basic ${TOKEN}` }))).toBe(
      false
    );
  });

  it("returns false when token does not match", async () => {
    envState.CLAUDE_READONLY_TOKEN = TOKEN;
    expect(await bearerTokenMatches(reqWith("GET", { authorization: "Bearer wrong-token" }))).toBe(
      false
    );
  });

  it("returns false when Bearer token is empty string", async () => {
    envState.CLAUDE_READONLY_TOKEN = TOKEN;
    expect(await bearerTokenMatches(reqWith("GET", { authorization: "Bearer " }))).toBe(false);
  });

  it("returns true when env and header tokens match", async () => {
    envState.CLAUDE_READONLY_TOKEN = TOKEN;
    expect(await bearerTokenMatches(reqWith("GET", { authorization: `Bearer ${TOKEN}` }))).toBe(
      true
    );
  });
});

describe("isAuthorized — Bearer branch", () => {
  it("authorizes Bearer + GET", async () => {
    envState.CLAUDE_READONLY_TOKEN = TOKEN;
    const r = reqWith("GET", { authorization: `Bearer ${TOKEN}` });
    expect(await isAuthorized(r)).toBe(true);
  });

  it("authorizes Bearer + HEAD", async () => {
    envState.CLAUDE_READONLY_TOKEN = TOKEN;
    const r = reqWith("HEAD", { authorization: `Bearer ${TOKEN}` });
    expect(await isAuthorized(r)).toBe(true);
  });

  it("authorizes Bearer + OPTIONS", async () => {
    envState.CLAUDE_READONLY_TOKEN = TOKEN;
    const r = reqWith("OPTIONS", { authorization: `Bearer ${TOKEN}` });
    expect(await isAuthorized(r)).toBe(true);
  });

  it("rejects Bearer + POST (falls through to no auth)", async () => {
    envState.CLAUDE_READONLY_TOKEN = TOKEN;
    const r = reqWith("POST", { authorization: `Bearer ${TOKEN}` });
    expect(await isAuthorized(r)).toBe(false);
  });

  it("rejects Bearer + DELETE", async () => {
    envState.CLAUDE_READONLY_TOKEN = TOKEN;
    const r = reqWith("DELETE", { authorization: `Bearer ${TOKEN}` });
    expect(await isAuthorized(r)).toBe(false);
  });

  it("rejects wrong Bearer + GET", async () => {
    envState.CLAUDE_READONLY_TOKEN = TOKEN;
    const r = reqWith("GET", { authorization: "Bearer wrong" });
    expect(await isAuthorized(r)).toBe(false);
  });
});

describe("getRequestIdentity", () => {
  it("returns CLAUDE_READONLY_IDENTITY for valid Bearer + safe method", async () => {
    envState.CLAUDE_READONLY_TOKEN = TOKEN;
    const r = reqWith("GET", { authorization: `Bearer ${TOKEN}` });
    expect(await getRequestIdentity(r)).toBe(CLAUDE_READONLY_IDENTITY);
  });

  it("returns null for Bearer + unsafe method", async () => {
    envState.CLAUDE_READONLY_TOKEN = TOKEN;
    const r = reqWith("POST", { authorization: `Bearer ${TOKEN}` });
    expect(await getRequestIdentity(r)).toBeNull();
  });

  it("returns null when no auth at all", async () => {
    envState.CLAUDE_READONLY_TOKEN = TOKEN;
    expect(await getRequestIdentity(reqWith("GET", {}))).toBeNull();
  });
});
