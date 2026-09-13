/**
 * OPE-909 items 1–2 — the CSP does not allow eval, the two places it is
 * declared agree, and Next does not advertise itself.
 *
 * Measured before removing 'unsafe-eval' (2026-09-13): live /, /events,
 * /login, /events/litchfield-fair, /vendors and /suggest-event loaded in
 * Chromium with the header rewritten without it — zero CSP violations,
 * GA + Turnstile still loaded. The same probe with googletagmanager removed
 * from script-src DID report violations, so the zero was not a blind probe.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const nextConfig = readFileSync(join(root, "next.config.mjs"), "utf8");
const headersFile = readFileSync(join(root, "public/_headers"), "utf8");

const cspFrom = (src: string, re: RegExp) => {
  const m = src.match(re);
  if (!m) throw new Error("CSP not found");
  return m[1];
};
// The config builds the CSP as `"<prefix>" + (dev ? " 'unsafe-eval'" : "") + "<rest>"`;
// the production value is prefix + rest.
const cspExpr = nextConfig.match(
  /key: "Content-Security-Policy",\s*value:\s*"([^"]+)"\s*\+\s*\(process\.env\.NODE_ENV === "development" \? " 'unsafe-eval'" : ""\)\s*\+\s*"([^"]+)"/
);
if (!cspExpr) throw new Error("CSP expression not found in next.config.mjs");
const configCsp = cspExpr[1] + cspExpr[2];
const headersCsp = cspFrom(headersFile, /Content-Security-Policy: (.+)/);

describe("OPE-909 — security headers", () => {
  it("script-src has no 'unsafe-eval'; POSITIVE LANDMARK: frame-ancestors 'none' is still there", () => {
    for (const csp of [configCsp, headersCsp]) {
      expect(csp).not.toContain("'unsafe-eval'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toMatch(/script-src 'self'/);
    }
  });

  it("next.config.mjs and public/_headers declare the same CSP", () => {
    expect(headersCsp.trim()).toBe(configCsp.trim());
  });

  it("'unsafe-eval' is allowed ONLY for the dev server (E2E runs `next dev`)", () => {
    expect(cspExpr[0]).toContain(`process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""`);
  });

  it("poweredByHeader is off", () => {
    expect(nextConfig).toMatch(/^\s*poweredByHeader: false,/m);
  });
});
