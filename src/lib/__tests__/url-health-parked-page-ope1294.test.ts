/**
 * OPE-1294 — a parked or disabled promoter site is `parked_page`, not
 * `no_event_signal`, and it reaches the review queue at WARNING.
 *
 * The rule is 200 + a tiny body + almost no visible text, and every fixture
 * here is a shape measured in prod on 2026-10-06 (Worker-side `body_bytes`,
 * checked against what a normal browser receives):
 *
 *   - parked:  norfieldgrange.com / vacationlandent.org — a 114-byte `/lander`
 *              JS bounce (verbatim below); capitalquiltersguild.com — a hosting
 *              "Website Disabled" page.
 *   - LIVE, must stay out: ~38 sites (osv.org, durhamfair.com, near-fest.com …)
 *              that the Worker sees as a SiteGround challenge — HTTP 202,
 *              174 bytes — and JS-rendered sites like clintonmainefair.org,
 *              166 KB with ~0 visible characters before scripts run.
 *
 * The ticket's original specimen, Clinton, turned out to be the second kind
 * (measured 10-04), so it is pinned here as a NEGATIVE.
 */
import { describe, it, expect } from "vitest";
import { classifyUrlHealth, isActionable, PARKED_MAX_BODY_BYTES } from "@/lib/goodwill/url-health";
import { PROJECTED_URL_HEALTH } from "@/lib/url-health-issues";

const ok200 = (html: string, status = 200) =>
  classifyUrlHealth({ reachedOrigin: true, status, html });

/** Verbatim from norfieldgrange.com and vacationlandent.org (114 bytes). */
const LANDER =
  '<!DOCTYPE html><html><head><script>window.onload=function(){window.location.href="/lander"}</script></head></html>';

/** capitalquiltersguild.com's hosting page, abridged to its shape (≈1.3 KB). */
const DISABLED =
  '<HTML> <HEAD> <TITLE>Website Disabled</TITLE> <LINK REL="stylesheet" HREF="/~site/css/hs5.css" TYPE="text/css"> </HEAD>' +
  ' <BODY BGCOLOR="#FFFFFF"><table><tr><td>Sorry,&nbsp;the&nbsp;site&nbsp;you&nbsp;requested&nbsp;has&nbsp;been&nbsp;disabled</td></tr></table></BODY></HTML>';

/** The SiteGround bot challenge the Worker receives from live sites (174 bytes, HTTP 202). */
const SG_CHALLENGE =
  '<html><head><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=%2F&y=ipc:1.2.3.4:1728000000.000"></meta></head><body></body></html>';

/** A JS-rendered live site: a large body whose text only exists after scripts run. */
const JS_RENDERED =
  '<!doctype html><html><head><title>Clinton Lions Agricultural Fair</title></head><body><div id="root"></div>' +
  `<script>${"window.__APP__=1;".repeat(4000)}</script></body></html>`;

/** A real organizer page whose dates live in an image: stays no_event_signal. */
const IMAGE_DATED =
  '<html><body><h1>Harvest Fair</h1><img src="/poster-2026.jpg" alt=""><p>' +
  "Welcome to our community celebration. Join neighbours and friends for food, crafts and music on the green. " +
  "Vendors and volunteers welcome, contact the committee for details about participation this season." +
  "</p></body></html>";

describe("OPE-1294 — parked_page", () => {
  it("the 114-byte /lander bounce (norfieldgrange, vacationlandent) is parked_page", () => {
    expect(LANDER.length).toBe(114);
    const r = ok200(LANDER);
    expect(r.verdict).toBe("parked_page");
    expect(r.detail).toContain("114-byte body");
  });

  it("a hosting 'Website Disabled' page is parked_page (47 visible chars, as the Worker measured it)", () => {
    const r = ok200(DISABLED);
    expect(r.detail).toContain("47 chars");
    expect(r.verdict).toBe("parked_page");
  });

  it("the SiteGround challenge (HTTP 202, 174 B) is NOT parked — it is a bot wall on a live site", () => {
    const r = ok200(SG_CHALLENGE, 202);
    expect(r.verdict).not.toBe("parked_page");
    expect(r.verdict).toBe("no_event_signal");
  });

  it("the same tiny body with status 202 stays out even if it were a lander", () => {
    expect(ok200(LANDER, 202).verdict).not.toBe("parked_page");
  });

  it("a JS-rendered live site (big body, ~0 visible chars — the Clinton shape) is NOT parked", () => {
    expect(JS_RENDERED.length).toBeGreaterThan(PARKED_MAX_BODY_BYTES);
    expect(ok200(JS_RENDERED).verdict).toBe("no_event_signal");
  });

  it("an image-dated organizer page stays no_event_signal (the ticket's control)", () => {
    expect(ok200(IMAGE_DATED).verdict).toBe("no_event_signal");
  });

  it("is actionable and projects to the review queue at WARNING (never ERROR)", () => {
    expect(isActionable("parked_page")).toBe(true);
    expect(PROJECTED_URL_HEALTH.parked_page).toBe("WARNING");
  });
});
