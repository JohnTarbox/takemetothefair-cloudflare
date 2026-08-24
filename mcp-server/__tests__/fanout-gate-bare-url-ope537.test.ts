/**
 * OPE-537 fix 2 — a URL is a source on its own.
 *
 * After the UA fix and the Browser Rendering fix, the re-submit (`2496a417`,
 * 2026-08-24) fetched the page for real — 4,870 chars — and STILL recorded:
 *
 *   multi-source-fanout  skipped
 *   {free_text_intent:false, body_has_prose_substance:false,
 *    body_url_count:1, body_chars:76}
 *
 * Acceptance criteria 1 and 2 (fanout present with a url source; citations
 * > 0) failed on a run whose criterion 3 (source_url non-null) passed —
 * because the URL was fetched by the single-URL submit path, not by the
 * fanout. Only the fanout writes citations.
 *
 * The gate read `!isFreeTextIntent && bodyHasSubstance && bodyUrls.length >= 1`,
 * making body PROSE a precondition for fanning out over URLS. The attachment
 * branch above it already treated them as independent. This pins that the two
 * branches now agree, and that the gate is defined ONCE.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(
  fileURLToPath(new URL("../src/workflows/inbound-email.ts", import.meta.url)),
  "utf8"
);

/** The gate as it now stands, extracted as a predicate. */
const shouldFanOut = (isFreeTextIntent: boolean, urlCount: number) =>
  !isFreeTextIntent && urlCount >= 1;

describe("the bare-URL specimen now fans out", () => {
  it("passes the gate that used to refuse it", () => {
    // inbound 2496a417: classifier said not-free-text, one URL, no prose.
    expect(shouldFanOut(false, 1)).toBe(true);
  });

  it("still refuses a body with no URL at all", () => {
    expect(shouldFanOut(false, 0)).toBe(false);
  });

  it("still refuses when the classifier says prose-only", () => {
    // A free-text intent means the prose IS the submission; fanning out over
    // incidental links in it would submit whatever the sender linked to.
    expect(shouldFanOut(true, 3)).toBe(false);
  });
});

describe("source wiring", () => {
  it("defines the gate exactly ONCE", () => {
    // The decline record and the execution branch must be exact complements.
    // Computed separately they drift, and drift here means either a run that
    // records a skip or a skip that records nothing — the defect class this
    // whole ticket is about.
    const definitions = SRC.match(/const shouldFanOut\s*=/g) ?? [];
    expect(definitions.length).toBe(1);
  });

  it("the decline record and the run branch both key off that one const", () => {
    expect(SRC).toContain("if (!shouldFanOut && !hasAttachmentSources) {");
    expect(SRC).toContain("if (shouldFanOut) {");
  });

  it("prose substance no longer appears in the fanout gate", () => {
    // The specific regression: re-introducing bodyHasSubstance as a
    // precondition would restore the skip while every test above still
    // passes, because they exercise the extracted predicate, not the source.
    const gateLine = SRC.match(/const shouldFanOut\s*=.*/)?.[0] ?? "";
    expect(gateLine).not.toContain("bodyHasSubstance");
    expect(gateLine).toContain("isFreeTextIntent");
    expect(gateLine).toContain("bodyUrls.length");
  });

  it("the body pseudo-source is still gated on prose substance", () => {
    // Dropping THIS guard would hand the extractor a copy of the bare URL as
    // if it were page content — which is how the fabricated description got
    // written in the first place. The fix must not reintroduce its own cause.
    expect(SRC).toContain(
      'if (bodyHasSubstance) sources.push({ kind: "body", text: bodyTextRaw });'
    );
  });
});
