/**
 * OPE-577 — suppress render-fault noise on PROVENANCE, not on message text.
 *
 * The OPE-84 Tier-1 scan of 2026-08-26 presented 8 eligible rows. Six were
 * noise and zero were real; every real fault that day came from the out-of-
 * ledger sweep instead.
 *
 * Every fixture below is a REAL row copied out of production `error_logs`, not
 * an invented shape. That matters twice over here: the `$RS@` case is only
 * convincing because it is genuinely our own bundle, and the ticket's proposed
 * rule was rejected precisely because real data contradicted it.
 */
import { describe, it, expect } from "vitest";
import {
  classifyNoise,
  isExtensionInjectionStack,
  contextSaysThirdParty,
  normalizeErrorClass,
} from "../signature";

describe("context.thirdParty — the ingest already knew", () => {
  it("suppresses a row the reporter flagged as third-party", () => {
    // Live: /events/taunton-lights-on-festival/2026, 2 occurrences.
    const v = classifyNoise({
      message: "Failed to fetch",
      route: "/events/taunton-lights-on-festival/2026",
      context:
        '{"errorType":"unhandledrejection","pathname":"/events/taunton-lights-on-festival/2026","thirdParty":true}',
    });
    expect(v.noise).toBe(true);
    expect(v.matched).toBe("context.thirdParty");
  });

  it("does NOT suppress the same shape on an auth route — the OPE-173 carve-out", () => {
    // `/register#script error.` was the registration-blocking Turnstile throw.
    // A third-party-looking shape on an auth route is exactly where being wrong
    // costs a signup, so provenance suppression yields to the carve-out.
    const v = classifyNoise({
      message: "Failed to fetch",
      route: "/register",
      context: '{"thirdParty":true}',
    });
    expect(v.noise).toBe(false);
  });

  it("treats a MALFORMED context as not-third-party — a parse failure must never suppress", () => {
    expect(contextSaysThirdParty("{not json")).toBe(false);
    expect(contextSaysThirdParty(null)).toBe(false);
    // Truthy-but-not-true must not count either.
    expect(contextSaysThirdParty('{"thirdParty":"yes"}')).toBe(false);
    expect(contextSaysThirdParty('{"thirdParty":1}')).toBe(false);
  });
});

describe("extension injection — and why the ticket's own rule was rejected", () => {
  it("suppresses the real Firefox-reader injection row", () => {
    // Live: /events/warner-fall-foliage-festival/2026.
    const v = classifyNoise({
      message: "ReferenceError: Can't find variable: __firefox__",
      route: "/events/warner-fall-foliage-festival/2026",
      stackTrace:
        "global code@https://meetmeatthefair.com/events/warner-fall-foliage-festival/2026:1:12",
    });
    expect(v.noise).toBe(true);
    expect(v.matched).toBe("extension-injection-stack");
  });

  it("suppresses the MetaMask `_G` variant on the same shape", () => {
    const v = classifyNoise({
      message: "ReferenceError: Can't find variable: _G",
      route: "/blog/fryeburg-fair-2026-everything-you-need-to-know-before-you-go",
      stackTrace:
        "global code@https://meetmeatthefair.com/blog/fryeburg-fair-2026-everything-you-need-to-know-before-you-go:1:3",
    });
    expect(v.noise).toBe(true);
  });

  it("does NOT fire on OUR OWN React streaming frames — the whole reason the ticket's rule was narrowed", () => {
    // THE case that overturned scope item 2. OPE-577 proposed denylisting
    // "`global code@<page-url>:1:N`" wherever it appears. Live, `global code@`
    // is on 90 rows and ~60 are THIS shape: our own bundle, `$RS` being React's
    // streaming-resume frame, with `global code@` merely the SECOND frame
    // because the streamed payload runs at page global scope.
    //
    // A substring rule would have suppressed our own render path.
    const stack =
      "$RS@https://meetmeatthefair.com/events/celebrate-wallingford/2026:23:306805\n" +
      "global code@https://meetmeatthefair.com/events/celebrate-wallingford/2026:23:306847";
    expect(
      isExtensionInjectionStack(
        "TypeError: null is not an object (evaluating 'b.parentNode')",
        stack
      )
    ).toBe(false);
  });

  it("requires BOTH conditions, not either", () => {
    // Right message, wrong frame (line 23 = our bundle, not an injected script).
    expect(
      isExtensionInjectionStack(
        "ReferenceError: Can't find variable: _G",
        "global code@https://meetmeatthefair.com/events/x:23:306805"
      )
    ).toBe(false);
    // Right frame, ordinary application error.
    expect(
      isExtensionInjectionStack(
        "TypeError: Cannot read properties of undefined",
        "global code@https://meetmeatthefair.com/events/x:1:12"
      )
    ).toBe(false);
  });

  it("keeps the auth carve-out for extension stacks too", () => {
    const v = classifyNoise({
      message: "ReferenceError: Can't find variable: __firefox__",
      route: "/login",
      stackTrace: "global code@https://meetmeatthefair.com/login:1:12",
    });
    expect(v.noise).toBe(false);
  });
});

describe("ResizeObserver — a spec notice, not an error", () => {
  it("is suppressed as ALWAYS-noise, including on auth routes", () => {
    const msg = "ResizeObserver loop completed with undelivered notifications.";
    expect(classifyNoise({ message: msg, route: "/events" }).noise).toBe(true);
    // Unlike the third-party list, this one has no route carve-out: there is no
    // version of a ResizeObserver loop notice that blocks a signup.
    const authVerdict = classifyNoise({ message: msg, route: "/register" });
    expect(authVerdict.noise).toBe(true);
    expect(authVerdict.reason).toBe("always");
  });
});

describe("the diagnostic token survives normalization (OPE-577 §4)", () => {
  it("keeps the full dotted path from an ASSIGNMENT expression — the Warner specimen", () => {
    // The row that filed the ticket. Before this, it reached a human as
    // `typeerror: undefined is not an object (evaluating )`, which reads like a
    // genuine empty-collection fault in our own render path.
    const out = normalizeErrorClass(
      "TypeError: undefined is not an object (evaluating 'window.ethereum.selectedAddress = undefined')"
    );
    expect(out).toContain("window.ethereum.selectedaddress");
    expect(out).not.toBe("typeerror: undefined is not an object (evaluating )");
  });

  it("still collapses a MINIFIED object local to `*` — OPE-613's rule, unchanged", () => {
    // A bundler-assigned single letter rotates on every rebuild, so keying on
    // it both under-matches after a deploy and can over-match a genuine fault.
    expect(
      normalizeErrorClass("TypeError: null is not an object (evaluating 'b.parentNode')")
    ).toBe("typeerror: null is not an object (evaluating *.parentnode)");
  });

  it("keeps a REAL object name, because myWidget.id and cart.id are different faults", () => {
    expect(
      normalizeErrorClass("TypeError: undefined is not an object (evaluating 'myWidget.config.id')")
    ).toContain("mywidget.config.id");
  });
});
