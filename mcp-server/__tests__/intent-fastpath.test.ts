/**
 * Tests for the trusted-sender fast-path regex pre-check.
 *
 * Pure-function tests — no I/O.
 */
import { describe, expect, it } from "vitest";
import {
  hasMultiIntentOrSpecialSignal,
  isReplyToOurThread,
  countDistinctHosts,
  isKnownScannerUa,
} from "../src/intent-fastpath.js";

const blank = {
  bodyText: "",
  bodyHtml: "",
  inReplyToHeader: null,
  referencesHeader: null,
} as const;

describe("hasMultiIntentOrSpecialSignal — single-intent body", () => {
  it("plain submission body does not trigger", () => {
    const out = hasMultiIntentOrSpecialSignal({
      ...blank,
      bodyText: "Here's our craft fair: https://example.com/event",
    });
    expect(out.trigger).toBe(false);
  });

  it("body with 1 URL does not trigger multi-URL", () => {
    expect(hasMultiIntentOrSpecialSignal({ ...blank, bodyText: "https://a.com/x" }).trigger).toBe(
      false
    );
  });
});

describe("hasMultiIntentOrSpecialSignal — multi-URL signal", () => {
  it("2 distinct hosts → trigger", () => {
    const out = hasMultiIntentOrSpecialSignal({
      ...blank,
      bodyText: "See https://a.com/x and https://b.com/y",
    });
    expect(out.trigger).toBe(true);
    expect(out.reason).toContain("multi-url");
  });

  it("3 distinct hosts → trigger", () => {
    const out = hasMultiIntentOrSpecialSignal({
      ...blank,
      bodyText: "https://a.com/x https://b.com/y https://c.com/z",
    });
    expect(out.trigger).toBe(true);
  });

  it("same host repeated does NOT trigger multi-URL", () => {
    const out = hasMultiIntentOrSpecialSignal({
      ...blank,
      bodyText: "https://a.com/x and https://a.com/y",
    });
    expect(out.trigger).toBe(false);
  });

  it("www. prefix collapsed to same host", () => {
    const out = hasMultiIntentOrSpecialSignal({
      ...blank,
      bodyText: "https://a.com/x and https://www.a.com/y",
    });
    expect(out.trigger).toBe(false);
  });
});

describe("hasMultiIntentOrSpecialSignal — keyword signals", () => {
  it("correction keyword (the date is)", () => {
    const out = hasMultiIntentOrSpecialSignal({
      ...blank,
      bodyText: "Hi — the date is wrong on that listing",
    });
    expect(out.trigger).toBe(true);
    expect(out.reason).toBe("correction-keyword");
  });

  it("source-suggestion keyword (I discovered)", () => {
    const out = hasMultiIntentOrSpecialSignal({
      ...blank,
      bodyText: "I discovered a website listing events",
    });
    expect(out.trigger).toBe(true);
    expect(out.reason).toBe("source-suggestion-keyword");
  });

  it("claim keyword (I am the organizer)", () => {
    const out = hasMultiIntentOrSpecialSignal({
      ...blank,
      bodyText: "Hi — I am the organizer of this event",
    });
    expect(out.trigger).toBe(true);
    expect(out.reason).toBe("claim-keyword");
  });
});

describe("hasMultiIntentOrSpecialSignal — reply chain", () => {
  it("In-Reply-To pointing at our domain triggers", () => {
    const out = hasMultiIntentOrSpecialSignal({
      ...blank,
      bodyText: "thanks!",
      inReplyToHeader: "<abc123@notify.meetmeatthefair.com>",
    });
    expect(out.trigger).toBe(true);
    expect(out.reason).toBe("reply-chain");
  });

  it("References pointing at our apex triggers", () => {
    expect(isReplyToOurThread(null, "<x@meetmeatthefair.com> <y@meetmeatthefair.com>")).toBe(true);
  });

  it("3rd-party In-Reply-To does not trigger", () => {
    expect(isReplyToOurThread("<x@gmail.com>", null)).toBe(false);
  });
});

describe("countDistinctHosts", () => {
  it("zero URLs → 0", () => {
    expect(countDistinctHosts("nothing here")).toBe(0);
  });
  it("strips www.", () => {
    expect(countDistinctHosts("https://a.com/x https://www.a.com/y")).toBe(1);
  });
  it("counts http and https as same host", () => {
    expect(countDistinctHosts("http://a.com/x https://a.com/y")).toBe(1);
  });
});

describe("isKnownScannerUa", () => {
  it("matches Microsoft Safe Links UA", () => {
    expect(isKnownScannerUa("Microsoft-Office/16.0 (SafeLinks)")).toBe(true);
  });
  it("matches Mimecast UA", () => {
    expect(isKnownScannerUa("Mimecast-Link-Scanner")).toBe(true);
  });
  it("does not match a real browser UA", () => {
    expect(isKnownScannerUa("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe(false);
  });
  it("empty UA → false (don't assume scanner)", () => {
    expect(isKnownScannerUa("")).toBe(false);
  });
});
