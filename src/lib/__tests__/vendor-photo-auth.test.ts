import { describe, it, expect } from "vitest";
import { assertPhotosBelongTo } from "../vendor-photo-auth";

/**
 * OPE-211 — the reorder route's real attack surface.
 *
 * Authorising the VENDOR is not enough. A caller who legitimately owns vendor
 * A can send A's id with a photo-id list containing one of vendor B's photos;
 * without this check the UPDATE renumbers B's photo, from a request that
 * passed authorization. Pure set logic, so it is tested directly rather than
 * through the route.
 */
describe("assertPhotosBelongTo (OPE-211)", () => {
  it("accepts a list wholly owned by the vendor", () => {
    expect(assertPhotosBelongTo(["a", "b"], ["a", "b", "c"])).toEqual({ ok: true });
  });

  it("REJECTS a foreign id smuggled into an otherwise-owned list", () => {
    // The cross-tenant write. Everything here is the caller's except "evil".
    const r = assertPhotosBelongTo(["a", "evil", "b"], ["a", "b", "c"]);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.foreign).toEqual(["evil"]);
  });

  it("names every foreign id, not just the first", () => {
    const r = assertPhotosBelongTo(["x", "y"], ["a"]);
    expect(r.ok === false && r.foreign).toEqual(["x", "y"]);
  });

  it("accepts a partial list — reordering a subset is legitimate", () => {
    expect(assertPhotosBelongTo(["b"], ["a", "b", "c"])).toEqual({ ok: true });
  });

  it("rejects any id when the vendor owns nothing", () => {
    // A vendor with an empty gallery must not be a wildcard.
    const r = assertPhotosBelongTo(["a"], []);
    expect(r.ok).toBe(false);
  });

  it("treats an empty request as trivially owned", () => {
    // The route's schema already requires min(1); this pins that the helper
    // itself does not invent a rejection the caller cannot act on.
    expect(assertPhotosBelongTo([], ["a"])).toEqual({ ok: true });
  });

  it("does not match on a prefix or a near-miss id", () => {
    // Set membership, not substring — an id like "a" must not authorise "ab".
    const r = assertPhotosBelongTo(["ab"], ["a"]);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.foreign).toEqual(["ab"]);
  });

  it("is case-sensitive", () => {
    // Ids are UUIDs; a case-insensitive compare would widen the ownership set
    // for no reason.
    expect(assertPhotosBelongTo(["A"], ["a"]).ok).toBe(false);
  });
});
