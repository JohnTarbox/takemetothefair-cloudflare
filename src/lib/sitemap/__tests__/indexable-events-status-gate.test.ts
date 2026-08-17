/**
 * OPE-439 — the property that makes `completeness_score` safe to consume.
 *
 * The score measures FIELDS FILLED, not correctness. A junk duplicate from an
 * email submission scored **85** against the APPROVED event it duplicated at
 * **60** — no venue, placeholder promoter, 0 views, and a sibling row carrying
 * fabricated 2024 dates. It won on having a description and ticket prices.
 *
 * The consumer census (OPE-439) found nothing that sorts a human review queue
 * by it, so the feared inverse-attention allocation does not exist. The one
 * consumer with real consequence is sitemap inclusion:
 *
 *     isPublicEventStatus() AND startDate NOT NULL AND score >= 40
 *
 * and what protects it is the **status gate**, not the threshold. 40 is low
 * enough that a padded fabrication clears it easily; what a fabricated PENDING
 * row cannot do is pass `isPublicEventStatus()`. A human approving it is the
 * real control.
 *
 * So this test pins the conjunction. Dropping the status predicate — or
 * "simplifying" the query to lean on the score alone — would make an inflated
 * score sufficient for indexing, which is the actual latent risk in the ticket.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SOURCE = readFileSync(resolve(__dirname, "..", "indexable-events.ts"), "utf8");

describe("sitemap inclusion is gated on STATUS, not only on completeness", () => {
  it("still applies isPublicEventStatus()", () => {
    // Remove this and a PENDING row with a padded score becomes indexable.
    expect(SOURCE).toContain("isPublicEventStatus()");
  });

  it("still requires a start date", () => {
    expect(SOURCE).toMatch(/isNotNull\(\s*events\.startDate\s*\)/);
  });

  it("applies the completeness floor as an ADDITIONAL condition, not the only one", () => {
    // The three predicates must sit inside one `and(...)`. A refactor that
    // kept only the score would still satisfy a naive "does it mention
    // SITEMAP_MIN_COMPLETENESS" check, so assert the companions explicitly.
    expect(SOURCE).toContain("SITEMAP_MIN_COMPLETENESS");
    // lastIndexOf, not indexOf: the FIRST occurrence is the import statement,
    // which sits above the query — slicing to it yields an empty window that
    // passes or fails for the wrong reason.
    const usage = SOURCE.lastIndexOf("SITEMAP_MIN_COMPLETENESS");
    const andBlock = SOURCE.slice(SOURCE.lastIndexOf("and(", usage), usage);
    expect(andBlock).toContain("isPublicEventStatus()");
  });
});

describe("the score is not used to order anything a human triages", () => {
  it("indexable-events does not ORDER BY completeness", () => {
    // Census finding, pinned: the only ORDER BY on this column anywhere is the
    // vendor enrichment selector, and it is ASC (least-complete first), which
    // deprioritises a padded row rather than promoting it.
    expect(SOURCE).not.toMatch(/orderBy[\s\S]{0,80}completenessScore/);
  });
});
