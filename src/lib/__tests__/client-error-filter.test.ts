import { describe, expect, it } from "vitest";
import { isKnownClientNoise } from "../client-error-filter";

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
