/**
 * OPE-1573 — a malformed `?page=` on /events or /events/past is a REAL 404,
 * set in middleware before render.
 *
 * #1800 made the pages call `notFound()` before any D1 query, but
 * `(listing)/loading.tsx` streams the 200 + shell first, so prod answered the
 * 2026-11-13 SQLi scanner's `?page=2' UNION …` with a soft-404 200. These run
 * the real `middleware` (no Cloudflare context needed: every asserted path
 * returns before the env lookup) and Next's own matcher.
 */
import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { middleware, config } from "@/middleware";

const req = (pathAndQuery: string) => new NextRequest(`https://meetmeatthefair.com${pathAndQuery}`);
const matches = (path: string) =>
  unstable_doesMiddlewareMatch({ config, url: `https://meetmeatthefair.com${path}` });

const MALFORMED = [
  "?page=2'%20UNION%20ALL%20SELECT%20NULL--",
  "?page=abc",
  "?page=0",
  "?page=-1",
  "?page=02",
  "?page=10000",
  "?page=2&page=3",
];

describe("OPE-1573 listing ?page= 404 in middleware", () => {
  it("the matcher now runs middleware on /events and /events/past", () => {
    expect(matches("/events")).toBe(true);
    expect(matches("/events/past")).toBe(true);
    // Facet listings are still out — this change adds /events alone.
    expect(matches("/events/maine/this-weekend")).toBe(false);
  });

  for (const path of ["/events", "/events/past"]) {
    for (const q of MALFORMED) {
      it(`404s ${path}${q}`, async () => {
        const res = await middleware(req(`${path}${q}`));
        expect(res.status).toBe(404);
        expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
      });
    }
  }

  // Positive landmarks: valid /events requests pass straight through (no
  // routing, no CF env), so a parser that rejected everything would fail here.
  for (const q of ["", "?page=", "?page=1", "?page=2", "?page=9999", "?state=maine"]) {
    it(`passes /events${q} through untouched`, async () => {
      const res = await middleware(req(`/events${q}`));
      expect(res.status).toBe(200);
      expect(res.headers.get("x-middleware-next")).toBe("1");
    });
  }
});
