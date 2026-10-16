/**
 * OPE-1380 — middleware picks the CSP: a fresh nonce policy on the uncached
 * admin/auth/portal/account routes, nothing (the next.config public policy) on
 * the cached public pages.
 */
import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { middleware, config } from "@/middleware";
import { NONCE_CSP_PREFIXES, isNonceCspPath, nonceContentSecurityPolicy } from "@/lib/csp";
import nextConfig from "../../next.config.mjs";

const req = (path: string, init?: ConstructorParameters<typeof NextRequest>[1]) =>
  new NextRequest(`https://meetmeatthefair.com${path}`, init);

function nonceOf(csp: string | null): string | undefined {
  return /'nonce-([A-Za-z0-9+/_-]+={0,2})'/.exec(csp ?? "")?.[1];
}

function scriptSrc(csp: string): string {
  return (
    csp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("script-src")) ?? ""
  );
}

const PROTECTED = [
  "/admin",
  "/admin/claims",
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password/abc123",
  "/verify-email/abc123",
  "/vendor/profile",
  "/vendor/applications",
  "/promoter/events",
  "/promoter/events/new",
  "/suggest-event",
  "/dashboard",
  "/dashboard/settings",
];

describe("OPE-1380 — protected routes get a per-request nonce CSP", () => {
  it.each(PROTECTED)(
    "%s → nonce + strict-dynamic, no 'unsafe-inline' in script-src",
    async (path) => {
      const res = await middleware(req(path));
      const csp = res.headers.get("Content-Security-Policy");
      expect(csp, path).toBeTruthy();
      const nonce = nonceOf(csp);
      expect(nonce, path).toMatch(/^[A-Za-z0-9+/]{22}==$/); // 16 random bytes
      const src = scriptSrc(csp!);
      expect(src).toContain("'strict-dynamic'");
      expect(src).not.toContain("'unsafe-inline'");
      expect(src).not.toContain("'unsafe-eval'"); // vitest is not `next dev`
      expect(csp).toContain("frame-ancestors 'none'");
    }
  );

  it("forwards the SAME policy + nonce on the request, where Next.js reads it", async () => {
    const res = await middleware(req("/login"));
    expect(res.headers.get("x-middleware-next")).toBe("1");
    const csp = res.headers.get("Content-Security-Policy")!;
    expect(res.headers.get("x-middleware-request-content-security-policy")).toBe(csp);
    expect(res.headers.get("x-middleware-request-x-nonce")).toBe(nonceOf(csp));
    expect(res.headers.get("x-middleware-override-headers")).toMatch(/content-security-policy/);
  });

  it("the nonce differs on every request", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) {
      seen.add(
        nonceOf((await middleware(req("/admin/claims"))).headers.get("Content-Security-Policy"))!
      );
    }
    expect(seen.size).toBe(5);
  });

  it("keeps the routing it had: /vendor/<slug> still 301s to the plural page", async () => {
    const res = await middleware(req("/vendor/westfield-river-brewing"));
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(
      "https://meetmeatthefair.com/vendors/westfield-river-brewing"
    );
  });

  it("keeps the routing it had: /help/<slug>.md is still served (public, no nonce)", async () => {
    const res = await middleware(req("/help/how-to-suggest-an-event.md"));
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });
});

describe("OPE-1380 — public routes keep the next.config policy", () => {
  it.each(["/events/some-fair", "/vendors/some-vendor", "/blog/some-post", "/venues/x"])(
    "%s → middleware sets no CSP and forwards no nonce",
    async (path) => {
      const res = await middleware(req(path));
      expect(res.headers.get("Content-Security-Policy")).toBeNull();
      expect(res.headers.get("x-middleware-request-x-nonce")).toBeNull();
      expect(res.headers.get("x-middleware-request-content-security-policy")).toBeNull();
    }
  );

  it("isNonceCspPath does not swallow the public plural directories", () => {
    for (const p of ["/vendors", "/vendors/x", "/promoters/x", "/vendor-guide", "/", "/about"]) {
      expect(isNonceCspPath(p), p).toBe(false);
    }
    for (const p of NONCE_CSP_PREFIXES) {
      expect(isNonceCspPath(p)).toBe(true);
      expect(isNonceCspPath(`${p}/x`)).toBe(true);
    }
  });

  it("the matcher runs middleware on every protected prefix", () => {
    for (const p of NONCE_CSP_PREFIXES) {
      for (const url of [p, `${p}/x`]) {
        expect(
          unstable_doesMiddlewareMatch({ config, url: `https://meetmeatthefair.com${url}` }),
          url
        ).toBe(true);
      }
    }
  });
});

describe("OPE-1380 — next.config headers()", () => {
  type Rule = { source: string; headers: { key: string; value: string }[] };
  const rulesFor = async (path: string) => {
    const { buildCustomRoute } = await import("next/dist/lib/build-custom-route");
    const rules = (await nextConfig.headers!()) as Rule[];
    return rules.filter((r) =>
      new RegExp(buildCustomRoute("header", { source: r.source, headers: [] }).regex).test(path)
    );
  };
  const headerOf = (rules: Rule[], key: string) =>
    rules.flatMap((r) => r.headers).filter((h) => h.key === key);

  it("a cached public page keeps its CDN cache header and the public CSP", async () => {
    const about = await rulesFor("/about");
    expect(headerOf(about, "Cloudflare-CDN-Cache-Control").map((h) => h.value)).toEqual([
      "public, max-age=86400",
    ]);
    const csp = headerOf(about, "Content-Security-Policy");
    expect(csp).toHaveLength(1);
    expect(scriptSrc(csp[0].value)).toContain("'unsafe-inline'");
    expect(csp[0].value).not.toContain("nonce-");

    const event = await rulesFor("/events/some-fair");
    expect(headerOf(event, "Cloudflare-CDN-Cache-Control").map((h) => h.value)).toEqual([
      "public, max-age=600, stale-while-revalidate=300",
    ]);
    expect(headerOf(event, "Content-Security-Policy")).toHaveLength(1);
  });

  it("a nonce route gets NO next.config CSP (middleware's is the only one) but keeps the rest", async () => {
    for (const p of ["/admin", "/login", "/vendor/profile", "/dashboard/settings"]) {
      const rules = await rulesFor(p);
      expect(headerOf(rules, "Content-Security-Policy"), p).toHaveLength(0);
      expect(headerOf(rules, "X-Frame-Options"), p).toHaveLength(1);
      expect(headerOf(rules, "Strict-Transport-Security"), p).toHaveLength(1);
    }
  });

  it("the nonce policy differs from the public policy ONLY in script-src", async () => {
    const [pub] = headerOf(await rulesFor("/about"), "Content-Security-Policy");
    const strip = (csp: string) =>
      csp
        .split(";")
        .map((d) => d.trim())
        .filter((d) => d && !d.startsWith("script-src"));
    expect(strip(nonceContentSecurityPolicy("abc", { dev: false }))).toEqual(strip(pub.value));
  });
});
