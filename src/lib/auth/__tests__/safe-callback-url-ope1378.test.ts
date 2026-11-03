/**
 * OPE-1378 (AUTH6) — the login callbackUrl accepts same-origin relative paths only.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { safeCallbackUrl } from "../safe-callback-url";

describe("safeCallbackUrl", () => {
  it.each([
    "/",
    "/dashboard",
    "/claim/vendor/acme-farm",
    "/vendor/profile?tab=photos#top",
    "/events/x%2F%2Fy",
  ])("keeps the same-origin path %s", (p) => {
    expect(safeCallbackUrl(p)).toBe(p);
  });

  it.each([
    ["absolute https", "https://evil.example"],
    ["absolute http", "http://evil.example/dashboard"],
    ["protocol-relative", "//evil.example"],
    ["protocol-relative with path", "//evil.example/dashboard"],
    ["backslash host", "/\\evil.example"],
    ["double backslash", "\\\\evil.example"],
    ["tab-smuggled slash", "/\t/evil.example"],
    ["newline-smuggled slash", "/\n/evil.example"],
    ["javascript scheme", "javascript:alert(1)"],
    ["bare host", "evil.example"],
    ["empty", ""],
  ])("rejects %s", (_label, p) => {
    expect(safeCallbackUrl(p)).toBe("/");
  });

  it("falls back for null / undefined", () => {
    expect(safeCallbackUrl(null)).toBe("/");
    expect(safeCallbackUrl(undefined)).toBe("/");
  });
});

describe("login page routes callbackUrl through safeCallbackUrl", () => {
  it("reads the query param ONLY via the helper", () => {
    const src = readFileSync(
      join(__dirname, "..", "..", "..", "app", "(auth)", "login", "page.tsx"),
      "utf8"
    );
    const reads = src.match(/searchParams\.get\("callbackUrl"\)/g) ?? [];
    expect(reads).toHaveLength(1);
    expect(src).toMatch(/safeCallbackUrl\(searchParams\.get\("callbackUrl"\)\)/);
  });

  it("no other page reads callbackUrl from the query string unguarded", () => {
    // The only reader today is the login page; registration and the claim pages
    // build callbackUrl themselves. If a new reader appears, route it through
    // safeCallbackUrl and add it here.
    const root = join(__dirname, "..", "..", "..", "..");
    const walk = (dir: string, acc: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "__tests__") continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full, acc);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) acc.push(full);
      }
      return acc;
    };
    const out = walk(join(root, "src"))
      .filter((f) => /get\("callbackUrl"\)/.test(readFileSync(f, "utf8")))
      .map((f) => relative(root, f).replace(/\\/g, "/"));
    expect(out).toEqual(["src/app/(auth)/login/page.tsx"]);
  });
});
