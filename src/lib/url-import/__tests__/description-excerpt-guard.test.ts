/**
 * OPE-537 fix 1, wired through the real extraction entry points.
 *
 * The detector has its own unit tests (./truncated-excerpt.test.ts). What is
 * pinned HERE is that both extractors actually consult it — `extractEventData`
 * and `extractMultipleEvents` sanitize descriptions at two separate call
 * sites, and a guard wired into only one of them is this repo's most-repeated
 * defect shape (see feedback_fix_wired_into_one_of_two_parallel_paths).
 */
import { describe, it, expect } from "vitest";
import { extractMultipleEvents, extractEventData } from "../ai-extractor";
import type { PageMetadata } from "../types";

const md = {} as PageMetadata;
const mkAi = (resp: unknown) => ({ run: async () => resp }) as never;

const SHIPPED_EXCERPT =
  "On November 7th & 8th, Vermont Gatherings is proud to introduce a brand-new " +
  "event at the Champlain Valley Exposition — the Vermont Crafters Expo. " +
  "This is not a traditional craft […]";

describe("truncated descriptions are dropped, not stored", () => {
  it("multi-extract drops a CMS excerpt", async () => {
    const ai = mkAi({
      response: JSON.stringify([
        { name: "Vermont Crafters Expo", startDate: "2026-11-07", description: SHIPPED_EXCERPT },
      ]),
    });
    const { events } = await extractMultipleEvents(ai, "page text", md);
    expect(events[0].name).toBe("Vermont Crafters Expo");
    // The rest of the row survives — only the severed field is withheld.
    expect(events[0].description).toBeNull();
  });

  it("single-extract drops a CMS excerpt (the SECOND call site)", async () => {
    const ai = mkAi({
      response: JSON.stringify({
        name: "Vermont Crafters Expo",
        startDate: "2026-11-07",
        description: SHIPPED_EXCERPT,
      }),
    });
    // Name-grounding requires the name to appear in the source content, so
    // the fixture has to read like the page it stands in for.
    const { extracted } = await extractEventData(
      ai,
      "Vermont Crafters Expo — November 7th & 8th at the Champlain Valley Exposition.",
      md
    );
    expect(extracted.name).toBe("Vermont Crafters Expo");
    expect(extracted.description).toBeNull();
  });

  it("keeps a complete description", async () => {
    const good =
      "The Vermont Crafters Expo is designed for crafters, makers and artists. " +
      "Rather than vendors selling finished goods, it focuses on tools, " +
      "materials, education and resources that help people create.";
    const ai = mkAi({
      response: JSON.stringify([
        { name: "Vermont Crafters Expo", startDate: "2026-11-07", description: good },
      ]),
    });
    const { events } = await extractMultipleEvents(ai, "page text", md);
    expect(events[0].description).toBe(good);
  });

  it("keeps a LONG complete description that the length cap itself truncates", async () => {
    // The trap this fix could introduce. sanitizeString appends its own "..."
    // when it caps at 2000 chars; if the excerpt check ran AFTER that, every
    // long-but-complete description would look truncated and be nulled —
    // turning a guard against one bad field into a deleter of good ones.
    const long = "A complete sentence about the fair. ".repeat(100); // ~3500 chars
    expect(long.length).toBeGreaterThan(2000);
    const ai = mkAi({
      response: JSON.stringify([{ name: "Long Fair", startDate: "2027-06-01", description: long }]),
    });
    const { events } = await extractMultipleEvents(ai, "page text", md);
    expect(events[0].description).not.toBeNull();
    expect(events[0].description!.length).toBe(2000);
    // Capped by us, and it ends in our own marker — which must NOT round-trip
    // into a null on any future pass over stored data.
    expect(events[0].description!.endsWith("...")).toBe(true);
  });
});
