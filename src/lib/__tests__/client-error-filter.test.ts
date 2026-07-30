import { describe, expect, it } from "vitest";
import { isKnownClientNoise, isThirdPartyInjectedError } from "../client-error-filter";

describe("isKnownClientNoise", () => {
  it("matches the real prod stack from 2026-05-18 (React $RS frame)", () => {
    const stack = `TypeError: Cannot read properties of null (reading 'parentNode')
    at $RS (https://meetmeatthefair.com/events?query=Craftsman:7:79338)
    at https://meetmeatthefair.com/events?query=Craftsman:7:79407`;
    expect(isKnownClientNoise(stack)).toBe(true);
  });

  it("matches the $RC variant (other React streaming runtime frame)", () => {
    const stack = `TypeError: Cannot read properties of null (reading 'parentNode')
    at $RC (https://meetmeatthefair.com/events:7:79491)`;
    expect(isKnownClientNoise(stack)).toBe(true);
  });

  it("does not match real user-code stacks even with the same error message", () => {
    const stack = `TypeError: Cannot read properties of null (reading 'parentNode')
    at MyComponent (/src/components/foo.tsx:42:10)
    at button onClick (/src/components/foo.tsx:88:5)`;
    expect(isKnownClientNoise(stack)).toBe(false);
  });

  it("does not match arbitrary single-letter function names that aren't $R[A-Z]", () => {
    // Hypothetical user code with a variable named $XS — shouldn't match
    const stack = `Error: oops
    at $XS (/src/lib/something.js:1:1)
    at $S (/src/lib/other.js:1:1)`;
    expect(isKnownClientNoise(stack)).toBe(false);
  });

  it("returns false for missing stack", () => {
    expect(isKnownClientNoise(undefined)).toBe(false);
  });

  it("returns false for empty stack", () => {
    expect(isKnownClientNoise("")).toBe(false);
  });

  it("requires the `at ` prefix (literal frame), not just `$RS` anywhere in text", () => {
    // Defensive: a user-controlled message that happens to contain "$RS"
    // as a substring shouldn't match. The regex requires `at $RS` (word
    // boundary + literal " at ").
    const stack = `Error: failed to load $RS module from cdn
    at MyModule (/src/lib/loader.js:1:1)`;
    expect(isKnownClientNoise(stack)).toBe(false);
  });
});

describe("isThirdPartyInjectedError (OPE-301)", () => {
  // Verbatim prod stack, error_logs 8fdf482f-ed8e-4b71-85f0-5b2a02dc2526,
  // /events/barnstable-county-fair/2026, iOS Google-app (GSA) in-app browser.
  // Every frame anonymous — WebKit's `fn@` form with no source URL.
  const GSA_OVERFLOW_STACK = `@\n@\n@\n@\n${"Pk@\nNk@\n".repeat(20)}`;

  it("flags the real 2026-07-26 GSA stack that was mis-filed as a render fault", () => {
    expect(isThirdPartyInjectedError(GSA_OVERFLOW_STACK)).toBe(true);
  });

  it("flags the other two third-party rows in the same prod class", () => {
    // Browser-extension messaging error (desktop Linux UA).
    expect(
      isThirdPartyInjectedError(
        "Error: response not found for collectionResult\n    at <anonymous>"
      )
    ).toBe(true);
    // Injected/mangled script (Android UA) — our built bundle is valid by construction.
    expect(
      isThirdPartyInjectedError("SyntaxError: Unexpected token 'else'\n    at <anonymous>")
    ).toBe(true);
  });

  it("does NOT flag our own bundle — chunks are same-origin and keep their URLs", () => {
    const ours = `TypeError: undefined is not an object
    at EventDetail (https://meetmeatthefair.com/_next/static/chunks/app/events/page-abc.js:7:79338)
    at Nk (https://meetmeatthefair.com/_next/static/chunks/main-def.js:1:200)`;
    expect(isThirdPartyInjectedError(ours)).toBe(false);
  });

  it("does NOT flag a WebKit-format stack that still carries our URLs", () => {
    // Same `fn@` shape as the GSA stack — the URL is what distinguishes them,
    // not the frame format. This is the test that stops the check from
    // degenerating into 'WebKit stacks are third-party'.
    const webkitOurs = `Pk@https://meetmeatthefair.com/_next/static/chunks/main.js:1:20
Nk@https://meetmeatthefair.com/_next/static/chunks/main.js:1:40`;
    expect(isThirdPartyInjectedError(webkitOurs)).toBe(false);
  });

  it("does NOT flag dev/relative source frames", () => {
    expect(
      isThirdPartyInjectedError("Error: x\n    at MyComponent (/src/components/foo.tsx:42:10)")
    ).toBe(false);
  });

  it("stays conservative: no frames at all is 'unknown', not third-party", () => {
    expect(isThirdPartyInjectedError("Error: something went wrong")).toBe(false);
    expect(isThirdPartyInjectedError(undefined)).toBe(false);
    expect(isThirdPartyInjectedError("")).toBe(false);
  });
});
