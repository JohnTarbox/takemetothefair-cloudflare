/**
 * OPE-1155 — the declared-website rule shared by the register form and
 * /api/auth/register. The cases are the ticket's scope-1 list: social / Etsy /
 * Instagram links, paths, query strings, spaces, long URLs, http://.
 */
import { describe, it, expect } from "vitest";
import { normalizeDeclaredWebsite } from "../declared-website";

describe("normalizeDeclaredWebsite", () => {
  it.each([
    ["https://example.com", "https://example.com/"],
    ["http://example.com", "http://example.com/"],
    ["  https://example.com  ", "https://example.com/"],
    ["https://www.etsy.com/shop/PinePondPottery", "https://www.etsy.com/shop/PinePondPottery"],
    [
      "https://www.instagram.com/some.maker/?igsh=abc123",
      "https://www.instagram.com/some.maker/?igsh=abc123",
    ],
    [
      "https://www.facebook.com/profile.php?id=100012345",
      "https://www.facebook.com/profile.php?id=100012345",
    ],
    ["https://facebook.com/Some Page", "https://facebook.com/Some%20Page"],
    ["https://example.com/a/b?c=d#e", "https://example.com/a/b?c=d#e"],
    // No scheme: accepted with https:// rather than bounced.
    ["www.example.com", "https://www.example.com/"],
    ["etsy.com/shop/foo", "https://etsy.com/shop/foo"],
  ])("accepts %j", (input, expected) => {
    expect(normalizeDeclaredWebsite(input)).toBe(expected);
  });

  it.each([
    // All three of these PASSED the form's old regex and were refused by the
    // server's `.url()` — the gap that blocked a real vendor's account.
    "https://my site.com",
    "https://mysite.com https://www.facebook.com/mysite",
    "https://example.com:99999",
    // Refused before and still refused.
    "https://localhost",
    "javascript:alert(1)",
    "ftp://example.com",
    "",
    "   ",
    `https://example.com/${"a".repeat(2100)}`,
  ])("has no usable address in %j", (input) => {
    expect(normalizeDeclaredWebsite(input)).toBeNull();
  });

  it("returns null for a non-string", () => {
    expect(normalizeDeclaredWebsite(undefined)).toBeNull();
    expect(normalizeDeclaredWebsite(42)).toBeNull();
  });
});
