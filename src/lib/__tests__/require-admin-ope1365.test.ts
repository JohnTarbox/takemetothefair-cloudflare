/**
 * OPE-1365 — requireAdmin() behaviour: same rule as the admin layout
 * (read-only Bearer OR an ADMIN session), redirect for everyone else.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  authorization: null as string | null,
  session: null as null | { user: { id: string; role: string } },
  bearerOk: false,
}));

vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers(state.authorization ? { authorization: state.authorization } : {}),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock("@/lib/auth", () => ({ auth: async () => state.session }));
vi.mock("@/lib/api-auth", () => ({
  bearerTokenMatches: async (req: Request) =>
    state.bearerOk && req.headers.get("authorization") === "Bearer good",
}));

import { requireAdmin, ADMIN_LOGIN_REDIRECT } from "@/lib/require-admin";

beforeEach(() => {
  state.authorization = null;
  state.session = null;
  state.bearerOk = false;
});

describe("requireAdmin", () => {
  it("redirects a signed-out request to /login", async () => {
    await expect(requireAdmin()).rejects.toThrow(`NEXT_REDIRECT:${ADMIN_LOGIN_REDIRECT}`);
  });

  it("redirects a signed-in non-admin", async () => {
    state.session = { user: { id: "u1", role: "VENDOR" } };
    await expect(requireAdmin()).rejects.toThrow("NEXT_REDIRECT");
  });

  it("returns the session for an ADMIN", async () => {
    state.session = { user: { id: "a1", role: "ADMIN" } };
    await expect(requireAdmin()).resolves.toEqual(state.session);
  });

  it("accepts the read-only Bearer token (returns null, no session needed)", async () => {
    state.authorization = "Bearer good";
    state.bearerOk = true;
    await expect(requireAdmin()).resolves.toBeNull();
  });

  it("a wrong Bearer falls through to the session check", async () => {
    state.authorization = "Bearer bad";
    state.bearerOk = true;
    await expect(requireAdmin()).rejects.toThrow("NEXT_REDIRECT");
  });

  it("allowReadonlyBearer:false refuses a valid Bearer without an admin session", async () => {
    state.authorization = "Bearer good";
    state.bearerOk = true;
    await expect(requireAdmin({ allowReadonlyBearer: false })).rejects.toThrow("NEXT_REDIRECT");
  });
});
