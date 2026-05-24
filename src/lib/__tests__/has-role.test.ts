/**
 * Tests for the hasRole() helper that backs dual-role session checks.
 * Pure function over the session shape — no DB/auth integration needed.
 */
import { describe, expect, it } from "vitest";
import { hasRole } from "../auth";

describe("hasRole", () => {
  it("returns false on null session", () => {
    expect(hasRole(null, "VENDOR")).toBe(false);
  });

  it("returns false on undefined session", () => {
    expect(hasRole(undefined, "VENDOR")).toBe(false);
  });

  it("returns false when session has no user", () => {
    expect(hasRole({}, "VENDOR")).toBe(false);
  });

  it("returns false when user.roles is missing", () => {
    expect(hasRole({ user: {} }, "VENDOR")).toBe(false);
  });

  it("returns false when user.roles is empty array", () => {
    expect(hasRole({ user: { roles: [] } }, "VENDOR")).toBe(false);
  });

  it("returns true when user.roles contains the role", () => {
    expect(hasRole({ user: { roles: ["VENDOR"] } }, "VENDOR")).toBe(true);
  });

  it("returns true for dual-role users", () => {
    const session = { user: { roles: ["VENDOR", "PROMOTER"] as const } };
    expect(hasRole(session, "VENDOR")).toBe(true);
    expect(hasRole(session, "PROMOTER")).toBe(true);
    expect(hasRole(session, "ADMIN")).toBe(false);
    expect(hasRole(session, "USER")).toBe(false);
  });

  it("returns true for ADMIN-only users", () => {
    expect(hasRole({ user: { roles: ["ADMIN"] } }, "ADMIN")).toBe(true);
    expect(hasRole({ user: { roles: ["ADMIN"] } }, "VENDOR")).toBe(false);
  });

  it("is strict-match (no implicit role hierarchy)", () => {
    // Some auth systems treat ADMIN as implying all lower roles. We
    // don't — the array contains exactly the roles granted. If you
    // need ADMIN-implies-vendor semantics, callers do
    // `hasRole(s, "ADMIN") || hasRole(s, "VENDOR")` explicitly.
    expect(hasRole({ user: { roles: ["ADMIN"] } }, "VENDOR")).toBe(false);
  });
});
