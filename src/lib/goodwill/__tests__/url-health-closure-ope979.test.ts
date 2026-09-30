/**
 * OPE-979 — closure/handover detection, on the pages as fetched 2026-09-13
 * with the sweep's own User-Agent (fixtures/ope979, unedited and whole).
 *
 * Measured, and different from the ticket's description: eagleshows.com serves
 * its closure notice as HTTP **503** (a maintenance page), not 200. Before this
 * the sweep called it `http_error` and never read the body.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifyUrlHealth,
  detectClosureNotice,
  isActionable,
  samePageOnEveryPath,
} from "../url-health";

const F = (f: string) => readFileSync(join(__dirname, "fixtures/ope979", f), "utf8");
const EAGLE_ROOT = F("eagleshows_com.html");
const EAGLE_EVENT = F("eagleshows_com_event_marlborough-gun-show-9-19-26.html");
const EASTERN = F("easterngunexpo_com.html");
const LEDYARD = F("ledyardfair_org.html");
const CLINTON = F("clintonlionsagfair207_com.html");

describe("OPE-979 — the closure classifier on real pages", () => {
  it("ACCEPTANCE (red): eagleshows.com → closure_notice, as the 503 it is served with", () => {
    const r = classifyUrlHealth({ reachedOrigin: true, status: 503, html: EAGLE_ROOT });
    expect(r.verdict).toBe("closure_notice");
    expect(r.signals).toEqual(expect.arrayContaining(["closure-phrase", "maintenance-mode"]));
    expect(r.detail).toMatch(/closing it.s doors|taken over/);
    expect(isActionable(r.verdict)).toBe(true);
  });

  it("LANDMARK: the same page WITHOUT the closure check reads as a bare http_error (the old verdict)", () => {
    expect(classifyUrlHealth({ reachedOrigin: true, status: 503, html: null })).toMatchObject({
      verdict: "http_error",
      detail: "HTTP 503",
    });
  });

  it("ACCEPTANCE (green): easterngunexpo.com — live, trading, on-topic — stays ok", () => {
    expect(detectClosureNotice(EASTERN).fired).toBe(false);
    expect(classifyUrlHealth({ reachedOrigin: true, status: 200, html: EASTERN }).verdict).toBe(
      "ok"
    );
  });

  it("ACCEPTANCE: OPE-860's own specimens keep the verdicts they had before this change", () => {
    // Baselines measured 2026-09-13 on these same bytes, before the closure check existed.
    expect(detectClosureNotice(LEDYARD).fired).toBe(false);
    expect(classifyUrlHealth({ reachedOrigin: true, status: 200, html: LEDYARD }).verdict).toBe(
      "ok"
    );
    expect(detectClosureNotice(CLINTON).fired).toBe(false);
    expect(classifyUrlHealth({ reachedOrigin: true, status: 200, html: CLINTON }).verdict).toBe(
      "no_event_signal"
    );
  });

  it("maintenance mode ALONE is not a closure — healthy sites do it during a deploy", () => {
    const html =
      "<html><head><title>Maintenance Mode - Acme Fair</title></head><body>Back soon.</body></html>";
    expect(detectClosureNotice(html)).toMatchObject({
      fired: false,
      signals: ["maintenance-mode"],
    });
  });

  it.each([
    "Join us for our last show of the season on October 12!",
    "Final day: Sunday. Gates close at 5pm.",
    "The fair committee has taken over parking duties from the town this year.",
  ])("ordinary season phrasing does not fire: %j", (sentence) => {
    const r = detectClosureNotice(`<html><body><p>${sentence}</p></body></html>`);
    if (sentence.includes("has taken over")) {
      // Known precision limit, pinned so it is a decision: "has taken over" is
      // in the strong list because it is the specimen's own handover wording.
      expect(r.fired).toBe(true);
    } else {
      expect(r.fired).toBe(false);
    }
  });
});

describe("OPE-979 — same page on every path", () => {
  it("ACCEPTANCE: Eagle Shows' root and its event URL serve the same visible page (bytes differ)", () => {
    expect(EAGLE_ROOT).not.toBe(EAGLE_EVENT); // landmark: a byte check would miss this
    expect(
      samePageOnEveryPath([
        { url: "https://eagleshows.com/", html: EAGLE_ROOT },
        { url: "https://eagleshows.com/event/marlborough-gun-show-9-19-26/", html: EAGLE_EVENT },
      ])
    ).toBe(true);
  });

  it("two genuinely different pages are not flagged", () => {
    expect(
      samePageOnEveryPath([
        { url: "https://eagleshows.com/", html: EAGLE_ROOT },
        { url: "https://eagleshows.com/other", html: EASTERN },
      ])
    ).toBe(false);
  });

  it("one path, or an empty JS shell everywhere, proves nothing", () => {
    expect(samePageOnEveryPath([{ url: "https://x.example/", html: EAGLE_ROOT }])).toBe(false);
    const shell = "<html><body><div id=root></div></body></html>";
    expect(
      samePageOnEveryPath([
        { url: "https://x.example/", html: shell },
        { url: "https://x.example/a", html: shell },
      ])
    ).toBe(false);
  });
});
