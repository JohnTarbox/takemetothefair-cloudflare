/**
 * OPE-1368 — safeHref is the render-side guard for stored URLs (rows written
 * before urlSchema refused javascript:/data:, and the admin-written socialLinks).
 */
import { describe, it, expect } from "vitest";
import { safeHref, normalizeWebUrlInput } from "./safe-href";

describe("safeHref", () => {
  it.each([
    "javascript:alert(1)",
    "javascript:alert(1)//https://example.com",
    "JAVASCRIPT:alert(1)",
    "  javascript:alert(1)",
    "java\nscript:alert(1)",
    "java\tscript:alert(1)",
    "\u0001javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "/relative/path",
    "not a url",
    "",
    "   ",
  ])("returns undefined for %j", (v) => {
    expect(safeHref(v)).toBeUndefined();
  });

  it("returns undefined for non-strings", () => {
    expect(safeHref(null)).toBeUndefined();
    expect(safeHref(undefined)).toBeUndefined();
    expect(safeHref(42)).toBeUndefined();
  });

  it("passes http(s) through unchanged (no added slash, no re-encoding)", () => {
    expect(safeHref("https://example.com")).toBe("https://example.com");
    expect(safeHref("http://Example.com/a b?c=1")).toBe("http://Example.com/a b?c=1");
    expect(safeHref("  https://example.com/x  ")).toBe("https://example.com/x");
  });

  it("upgrades a bare domain to https://", () => {
    expect(safeHref("www.ecomaine.org")).toBe("https://www.ecomaine.org");
    expect(safeHref("etsy.com/shop/ohitssoap.dukie")).toBe("https://etsy.com/shop/ohitssoap.dukie");
    expect(safeHref("www.foo.com:8080/x")).toBe("https://www.foo.com:8080/x");
  });

  it("mailto/tel only when opted in", () => {
    expect(safeHref("mailto:a@b.org")).toBeUndefined();
    expect(safeHref("mailto:a@b.org", { allowMailto: true })).toBe("mailto:a@b.org");
    expect(safeHref("tel:+15555550100")).toBeUndefined();
    expect(safeHref("tel:+15555550100", { allowTel: true })).toBe("tel:+15555550100");
    expect(safeHref("javascript:alert(1)", { allowMailto: true, allowTel: true })).toBeUndefined();
  });

  // OPE-1385 — admin surfaces whose stored value is sometimes a site path.
  describe("allowRelative", () => {
    const rel = { allowRelative: true };
    it("accepts a same-origin root-relative path, unchanged", () => {
      expect(safeHref("/events/acme-fair", rel)).toBe("/events/acme-fair");
      expect(safeHref("/admin/recommendations?x=1#y", rel)).toBe("/admin/recommendations?x=1#y");
      expect(safeHref("/", rel)).toBe("/");
    });

    it("still refuses a relative path when not opted in", () => {
      expect(safeHref("/events/acme-fair")).toBeUndefined();
    });

    it.each([
      "//evil.test/x",
      "/\\evil.test/x",
      "/\t/evil.test/x",
      "/\n/evil.test/x",
      "javascript:alert(1)",
      "data:text/html,x",
      "events/no-leading-slash",
    ])("refuses %j (resolves off-origin or is not a web URL)", (v) => {
      expect(safeHref(v, rel)).toBeUndefined();
    });

    it("still accepts absolute http(s)", () => {
      expect(safeHref("https://example.com/a", rel)).toBe("https://example.com/a");
    });
  });
});

describe("normalizeWebUrlInput", () => {
  it("does not prefix something with a scheme", () => {
    expect(normalizeWebUrlInput("javascript:alert(1)")).toBe("javascript:alert(1)");
    expect(normalizeWebUrlInput("https://x.com")).toBe("https://x.com");
  });
});
