/**
 * OPE-1397 — requireRole()/requireSession() behaviour: the same rule as the
 * vendor/promoter portal layouts, so a page and its layout never disagree.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  session: null as null | { user: { id: string; role: string } },
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock("@/lib/auth", () => ({ auth: async () => state.session }));

import { requireRole, requireSession } from "@/lib/require-role";

beforeEach(() => {
  state.session = null;
});

describe("requireRole", () => {
  it("signed out → /login with the portal-home callback (same as the layout)", async () => {
    await expect(requireRole("VENDOR")).rejects.toThrow(
      "NEXT_REDIRECT:/login?callbackUrl=/vendor/profile"
    );
    await expect(requireRole("PROMOTER")).rejects.toThrow(
      "NEXT_REDIRECT:/login?callbackUrl=/promoter/events"
    );
  });

  it("signed out with an explicit callbackUrl uses it", async () => {
    await expect(requireRole("VENDOR", "/vendor/calendar")).rejects.toThrow(
      "NEXT_REDIRECT:/login?callbackUrl=/vendor/calendar"
    );
  });

  it("a session without a user id counts as signed out", async () => {
    state.session = { user: { id: "", role: "VENDOR" } };
    await expect(requireRole("VENDOR")).rejects.toThrow("NEXT_REDIRECT:/login");
  });

  it("wrong role → /dashboard", async () => {
    state.session = { user: { id: "u1", role: "USER" } };
    await expect(requireRole("VENDOR")).rejects.toThrow("NEXT_REDIRECT:/dashboard");
    state.session = { user: { id: "u1", role: "PROMOTER" } };
    await expect(requireRole("VENDOR")).rejects.toThrow("NEXT_REDIRECT:/dashboard");
    state.session = { user: { id: "u1", role: "VENDOR" } };
    await expect(requireRole("PROMOTER")).rejects.toThrow("NEXT_REDIRECT:/dashboard");
  });

  it("matching role or ADMIN → returns the session", async () => {
    state.session = { user: { id: "v1", role: "VENDOR" } };
    await expect(requireRole("VENDOR")).resolves.toEqual(state.session);
    state.session = { user: { id: "a1", role: "ADMIN" } };
    await expect(requireRole("PROMOTER")).resolves.toEqual(state.session);
  });
});

describe("requireSession", () => {
  it("signed out → /login with the callback", async () => {
    await expect(requireSession("/dashboard/claims")).rejects.toThrow(
      "NEXT_REDIRECT:/login?callbackUrl=/dashboard/claims"
    );
  });

  it("any signed-in role → returns the session", async () => {
    for (const role of ["USER", "VENDOR", "PROMOTER", "ADMIN"]) {
      state.session = { user: { id: "u1", role } };
      await expect(requireSession()).resolves.toEqual(state.session);
    }
  });
});
