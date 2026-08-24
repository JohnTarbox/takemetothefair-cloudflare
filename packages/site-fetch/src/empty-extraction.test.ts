/**
 * OPE-537 — a 200 that carries no extractable text is a FAILED fetch.
 *
 * After the UA fix removed the 403, the Vermont Crafters Expo re-submit
 * (`6ac06a0e`, 2026-08-24) recorded, between fetch and extract:
 *
 *     content_length_chars    0
 *     content_sha256_first16  e3b0c44298fc1c14     <- sha256 of ""
 *
 * `/api/admin/import-url/fetch` had returned `success: true` with an empty
 * string, and `/api/admin/import-url/extract` rejected it with a 400 several
 * services later. `shouldEscalate` judges the HTTP status alone, so Browser
 * Rendering — which exists for exactly this page shape — was never tried.
 */
import { describe, it, expect } from "vitest";
import {
  isEmptyExtraction,
  MIN_EXTRACTABLE_TEXT_CHARS,
  shouldEscalate,
  type FetchOutcome,
} from "./browser-rendering";

describe("isEmptyExtraction", () => {
  it("catches the exact shape that shipped the 400", () => {
    // sha256("") = e3b0c442… — this is what prod recorded.
    expect(isEmptyExtraction("")).toBe(true);
  });

  it("catches whitespace-and-residue, which an empty shell leaves behind", () => {
    expect(isEmptyExtraction("   \n\n\t  ")).toBe(true);
    expect(isEmptyExtraction("Home About Contact")).toBe(true);
  });

  it("treats null/undefined as empty rather than throwing", () => {
    expect(isEmptyExtraction(null)).toBe(true);
    expect(isEmptyExtraction(undefined)).toBe(true);
  });

  it("does NOT catch a real page, including a terse one", () => {
    // The threshold is "essentially no text", not "too little text to bother
    // with". A terse but genuine event page must not be escalated — that
    // would spend Browser Rendering latency and quota for nothing.
    expect(isEmptyExtraction("Kingfield Craft Fair — October 4, 9am to 4pm, Kingfield.")).toBe(
      false
    );
    // The real page this ticket is about extracts ~4,700 chars.
    expect(isEmptyExtraction("x".repeat(4709))).toBe(false);
  });

  it("sits just below anything a real page produces", () => {
    expect(MIN_EXTRACTABLE_TEXT_CHARS).toBeGreaterThan(0);
    expect(MIN_EXTRACTABLE_TEXT_CHARS).toBeLessThanOrEqual(64);
    expect(isEmptyExtraction("y".repeat(MIN_EXTRACTABLE_TEXT_CHARS - 1))).toBe(true);
    expect(isEmptyExtraction("y".repeat(MIN_EXTRACTABLE_TEXT_CHARS))).toBe(false);
  });
});

describe("why status alone was not enough", () => {
  it("shouldEscalate says NO to a 200 — which is why emptiness needs its own check", () => {
    // Pinning the gap this fix fills: a 200 never escalates, so an unreadable
    // 200 had no route to Browser Rendering at all.
    const ok200 = { ok: true, status: 200, html: "" } as unknown as FetchOutcome;
    expect(shouldEscalate(ok200)).toBe(false);
  });

  it("still escalates the auth-shaped statuses it always did", () => {
    for (const status of [401, 403, 429]) {
      const outcome = {
        ok: false,
        status,
        error: `http-${status}`,
        userMessage: "",
      } as unknown as FetchOutcome;
      expect(shouldEscalate(outcome)).toBe(true);
    }
  });
});
