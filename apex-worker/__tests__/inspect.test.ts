import { describe, expect, it } from "vitest";

import { ERROR_MARKER, hasErrorMarker } from "../src/inspect";

/**
 * Unit tests for the K2 Phase B marker detector. The Worker's status-
 * rewrite path fires whenever hasErrorMarker returns true, so these
 * tests pin both directions: the exact marker shape that error.tsx +
 * global-error.tsx emit must match, and adjacent shapes that look
 * similar must NOT match (so a typo in the React side surfaces as a
 * deploy-time miss, not as a false-positive 500 in production).
 */

describe("ERROR_MARKER constant", () => {
  it("uses the data-attribute spelling the React side emits", () => {
    // If this changes, src/app/error.tsx and src/app/global-error.tsx
    // must change in lockstep.
    expect(ERROR_MARKER).toBe('data-x-render-error="fetch"');
  });
});

describe("hasErrorMarker", () => {
  it("returns false for an empty body", () => {
    expect(hasErrorMarker("")).toBe(false);
  });

  it("returns false for a normal page body without the marker", () => {
    const body = `<!DOCTYPE html><html><body><h1>Welcome</h1><p>List of events</p></body></html>`;
    expect(hasErrorMarker(body)).toBe(false);
  });

  it("returns true when the marker appears as the first child (the canonical case)", () => {
    const body = `<!DOCTYPE html><html><body><div class="min-h-[60vh]"><span data-x-render-error="fetch" hidden>fetch</span><div class="text-center"><h1>Service temporarily unavailable</h1></div></div></body></html>`;
    expect(hasErrorMarker(body)).toBe(true);
  });

  it("returns true when the marker appears anywhere in the body", () => {
    // Defensive: if a future render places the marker deeper in the
    // tree, we still detect it. The Worker buffers the full body so
    // first-chunk-only detection isn't a requirement of the helper.
    const body = `<html><body><div><div><div><span data-x-render-error="fetch" hidden></span></div></div></div></body></html>`;
    expect(hasErrorMarker(body)).toBe(true);
  });

  it("returns false when the attribute name is misspelled", () => {
    // A typo in error.tsx (e.g. data-render-error instead of
    // data-x-render-error) must NOT silently match. This is the
    // "deploy-time miss surfaces as test failure" guarantee.
    const body = `<span data-render-error="fetch" hidden>fetch</span>`;
    expect(hasErrorMarker(body)).toBe(false);
  });

  it("returns false when the attribute value is wrong", () => {
    // Reserve room for future marker values (e.g. "auth" or "config")
    // by treating value mismatches as no-marker. Today the only valid
    // value is "fetch".
    const body = `<span data-x-render-error="other" hidden></span>`;
    expect(hasErrorMarker(body)).toBe(false);
  });

  it("returns false when attribute uses single quotes instead of double", () => {
    // React JSX always renders attributes with double quotes in the
    // serialized HTML. Tests pin that assumption so a future React
    // change that switches to single quotes surfaces here.
    const body = `<span data-x-render-error='fetch' hidden></span>`;
    expect(hasErrorMarker(body)).toBe(false);
  });

  it("returns true when multiple markers are present (sanity)", () => {
    // Defensive: error.tsx AND global-error.tsx could both render in
    // some edge cases (nested boundaries); either marker is enough.
    const body = `<span data-x-render-error="fetch"></span>... lots of HTML ...<span data-x-render-error="fetch"></span>`;
    expect(hasErrorMarker(body)).toBe(true);
  });

  it("returns false when only the visible H1 text matches (not the data attribute)", () => {
    // The marker is the data-attribute, NOT the visible "Service
    // temporarily unavailable" H1 (that text is the B5 smoke's marker,
    // which is intentional copy and may drift). The Worker must NOT
    // rewrite status based on the visible H1 — that would couple the
    // edge layer to UI copy.
    const body = `<h1>Service temporarily unavailable</h1>`;
    expect(hasErrorMarker(body)).toBe(false);
  });
});
