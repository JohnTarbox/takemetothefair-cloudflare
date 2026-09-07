/**
 * OPE-840 — every crawl-citation call site must gate on BOTH crawl signals.
 *
 * ## The bug this pins
 *
 * The crawl context is passed to `recordCitationsBestEffort` through a ternary.
 * It originally read `cand.crawlFilledFields ? {...} : undefined` — gating on
 * the PRICE signal alone. A site that publishes an exhibitor list but no
 * admission price (the majority shape for small fairs) therefore produced a
 * roster that was extracted, de-duplicated, counted... and never cited, because
 * the whole crawl argument was `undefined`.
 *
 * ## Why this is a source-level assertion
 *
 * There are THREE call sites — `submit/single/cite` (the N=1 collapse, which is
 * the dominant path), `.../cite` and `.../cite-keeper`. The recurring defect in
 * this file is a fix wired into some of them: it happened on this very ticket's
 * predecessor, where the provenance change initially reached two of three. A
 * behavioural test would exercise one path and leave the others free to drift,
 * which is precisely how the previous instance survived review.
 *
 * ⚠️ Anchored on the CALL syntax, not on a bare identifier: `crawlRosterNames`
 * also appears in the type declaration and in the assignment, so a naive
 * `includes()` would pass vacuously (the `indexOf`-matches-the-import-line
 * failure this repo has logged before).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "../src/workflows/inbound-email.ts"), "utf8");

describe("crawl-citation call sites", () => {
  // The positive landmark. If the call sites are ever renamed or restructured
  // this count changes and the suite says so, rather than a zero-match regex
  // reporting a clean bill of health.
  const guards = [...SRC.matchAll(/crawlFilledFields \|\| \w+\.crawlRosterNames/g)];

  it("finds all three call sites", () => {
    expect(guards).toHaveLength(3);
  });

  it("passes a roster source at every site that passes filledFields", () => {
    const filled = [...SRC.matchAll(/filledFields: \w+\.crawlFilledFields/g)];
    const roster = [...SRC.matchAll(/rosterSource: \w+\.crawlRosterSource/g)];
    expect(filled).toHaveLength(3);
    expect(roster).toHaveLength(3);
  });

  it("actually writes the vendor_roster citation", () => {
    // Pins the surviving mutant that produced the sibling test file: the whole
    // roster-citation block could be deleted from the workflow and every
    // crawl-layer and call-site test stayed green, because none of them
    // reached the one statement that puts the row in the database.
    expect(SRC).toMatch(/extraFields: \[\{ fieldName: "vendor_roster", value \}\]/);
    // ...guarded by BOTH a source and a non-empty roster, so an empty list
    // cannot cite an empty roster.
    expect(SRC).toMatch(/crawl\?\.rosterSource && \(crawl\.rosterNames\?\.length \?\? 0\) > 0/);
  });

  it("never gates the crawl context on the price signal alone", () => {
    // The exact pre-fix shape, in any of its three spellings.
    expect(SRC).not.toMatch(/\w+\.crawlFilledFields\s*\n?\s*\?\s*\{/);
  });
});

/**
 * OPE-847 — roster LINKING must reach the same three call sites.
 *
 * Same reasoning as the citation guard above, and the same history: the
 * provenance fix on OPE-837 initially reached two of three, and the roster
 * citation on OPE-840 was gated on the wrong signal at all three. This is the
 * third change to touch these sites, and it creates PUBLIC vendor rows, so a
 * path that silently skips it is the most expensive version of the miss.
 */
describe("roster vendor-linking call sites", () => {
  const calls = [...SRC.matchAll(/this\.linkRosterBestEffort\(/g)];

  it("is invoked at all three sites", () => {
    expect(calls).toHaveLength(3);
  });

  it("is guarded on a non-empty roster AND a source at every site", () => {
    const guards = [...SRC.matchAll(/\w+\.crawlRosterNames\?\.length && \w+\.crawlRosterSource/g)];
    expect(guards).toHaveLength(3);
  });

  it("covers the dedup-keeper branch, not only newly created events", () => {
    // OPE-175 ("inbound dedup should enrich with roster") is one of the three
    // tickets this work exists to unblock; excluding the keeper path would
    // leave it unaddressed.
    expect(SRC).toMatch(/`\$\{labelPrefix\}\/keeper`/);
    expect(SRC).toMatch(/dedup\.existingEventId,\n\s+cand\.crawlRosterNames/);
  });

  it("never asks for fuzzy dedup anywhere in the workflow", () => {
    expect(SRC).not.toMatch(/dedupStrategy:\s*"fuzzy"/);
  });
});
