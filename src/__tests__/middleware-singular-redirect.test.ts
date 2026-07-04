import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";

// OPE-87 — a stray singular `/vendor/<slug>` or `/promoter/<slug>` link (e.g. a
// blog typo) must 301 to the plural PUBLIC detail page, while the private portal
// sub-routes under the same singular prefix pass through untouched. This branch
// runs ahead of the Cloudflare env lookup (pure path rewrite), so it's testable
// with a plain NextRequest — no CF context mock, same as the /help/<slug>.md test.

describe("middleware singular → plural redirect (OPE-87)", () => {
  it("301s /vendor/<slug> to /vendors/<slug>", async () => {
    const res = await middleware(
      new NextRequest("https://meetmeatthefair.com/vendor/westfield-river-brewing")
    );
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(
      "https://meetmeatthefair.com/vendors/westfield-river-brewing"
    );
  });

  it("301s /promoter/<slug> to /promoters/<slug>", async () => {
    const res = await middleware(new NextRequest("https://meetmeatthefair.com/promoter/some-org"));
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://meetmeatthefair.com/promoters/some-org");
  });

  it("preserves the query string on redirect", async () => {
    const res = await middleware(
      new NextRequest("https://meetmeatthefair.com/vendor/joes-kettle-corn?ref=blog")
    );
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(
      "https://meetmeatthefair.com/vendors/joes-kettle-corn?ref=blog"
    );
  });

  it("does NOT redirect the private vendor portal routes", async () => {
    for (const seg of ["profile", "calendar", "applications", "submissions", "suggest-event"]) {
      const res = await middleware(new NextRequest(`https://meetmeatthefair.com/vendor/${seg}`));
      // Passthrough (NextResponse.next()) — never a redirect to the plural path.
      expect(res.status).not.toBe(301);
      expect(res.headers.get("location")).toBeNull();
    }
  });

  it("does NOT redirect the private promoter portal route /promoter/events", async () => {
    const res = await middleware(new NextRequest("https://meetmeatthefair.com/promoter/events"));
    expect(res.status).not.toBe(301);
    expect(res.headers.get("location")).toBeNull();
  });
});
