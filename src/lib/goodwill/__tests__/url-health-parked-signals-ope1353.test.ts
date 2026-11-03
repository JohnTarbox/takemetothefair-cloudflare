/**
 * OPE-1353 — `parked_page` needs a parked SHAPE, not just a small body.
 *
 * OPE-1294's rule (200 + < 2,048 bytes + < 50 visible chars) called 7 promoter
 * sites parked; curled with our UA on 2026-10-15, 4 were live — a 1,018-byte
 * Vite JS-app shell (madisonct, wethersfieldchamber) and a 518 / 642-byte frame
 * page (cheshiregrange, grandesfestas). The real ones are pinned in
 * url-health-empty-body-ope1350.test.ts from verbatim fixtures; this file pins
 * one synthetic specimen per signal, both directions.
 */
import { describe, expect, it } from "vitest";
import { classifyUrlHealth, liveShellKind, parkedMarkers } from "../url-health";

const c = (html: string, finalUrl?: string) =>
  classifyUrlHealth({ reachedOrigin: true, status: 200, html, finalUrl });

describe("OPE-1353 — positive parked markers → parked_page", () => {
  it.each([
    [
      "lander-redirect (location.replace form)",
      '<html><head><script>location.replace("/lander")</script></head></html>',
      "lander-redirect",
    ],
    [
      "parking-host in markup",
      '<html><body><script src="https://www.sedoparking.com/frmpark/x.js"></script></body></html>',
      "parking-host",
    ],
    [
      "domain-for-sale",
      "<html><head><title>example.org</title></head><body><h1>This domain is for sale!</h1><p>Make an offer today and own this name forever.</p></body></html>",
      "domain-for-sale",
    ],
    [
      "site-disabled (account suspended)",
      "<html><head><title>Account Suspended</title></head><body><p>This account has been suspended. Contact your hosting provider for more information.</p></body></html>",
      "site-disabled",
    ],
  ])("%s", (_label, html, marker) => {
    const r = c(html);
    expect(r.verdict).toBe("parked_page");
    expect(r.signals).toContain(marker);
  });

  it("a redirect that landed on a parking host is parked even with a bland body", () => {
    const r = c(
      "<html><body><p>Loading</p></body></html>",
      "https://www.hugedomains.com/domain_profile.cfm?d=x"
    );
    expect(r.verdict).toBe("parked_page");
    expect(r.signals).toContain("parking-host");
  });

  it("a parking lander built AS a JS shell is still parked (marker beats the shell exemption)", () => {
    const html =
      '<html><head><script src="/assets/app.js"></script></head><body><div id="root"></div><script>window.location.href="/lander"</script></body></html>';
    expect(liveShellKind(html)?.kind).toBe("js-app-shell");
    expect(c(html).verdict).toBe("parked_page");
  });

  it("the markers do not fire on ordinary organizer prose", () => {
    expect(
      parkedMarkers(
        "<html><body><p>Our fair website has moved. Vendor applications are disabled until March.</p><a href='/landing'>home</a></body></html>"
      )
    ).toEqual([]);
  });
});

describe("OPE-1353 — live wrappers → no_event_signal, never parked_page", () => {
  it.each([
    [
      "Vite/React shell",
      '<!doctype html><html><head><script type="module" src="/assets/index-abc.js"></script></head><body><div id="root"></div></body></html>',
      "js-app-shell",
    ],
    [
      "Next.js shell",
      '<html><body><div id="__next"></div><script src="/_next/static/chunks/main.js"></script></body></html>',
      "js-app-shell",
    ],
    [
      "Angular shell",
      '<html><body><app-root></app-root><script src="main.js"></script></body></html>',
      "js-app-shell",
    ],
    [
      "frameset",
      '<html><frameset rows="*"><frame src="home.htm"></frameset></html>',
      "frame-wrapper",
    ],
    [
      "full-page iframe",
      '<html><body style="margin:0"><iframe src="https://example.wixsite.com/fair" style="width:100%;height:100%"></iframe></body></html>',
      "frame-wrapper",
    ],
  ])("%s", (_label, html, kind) => {
    const r = c(html);
    expect(r.verdict).toBe("no_event_signal");
    expect(r.signals).toEqual([kind]);
  });

  it("a mount node WITHOUT an external bundle is not a JS shell (stays parked-shell)", () => {
    const r = c('<html><body><div id="root"></div></body></html>');
    expect(r.verdict).toBe("parked_page");
    expect(r.signals).toEqual(["parked-shell"]);
  });

  it("an external script WITHOUT a mount node is not a JS shell (stays parked-shell)", () => {
    const r = c('<html><head><script src="/analytics.js"></script></head><body></body></html>');
    expect(r.verdict).toBe("parked_page");
    expect(r.signals).toEqual(["parked-shell"]);
  });
});
