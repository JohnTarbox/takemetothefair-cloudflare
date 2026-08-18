/**
 * OPE-457 — a citation must not attribute a fact to a source that cannot contain it.
 *
 * Email "MV 2" (submit@, 2026-08-17T23:52:41Z) had one line of body:
 *
 *     https://vineyardartisans.com/
 *
 * Three events were created — "Vineyard Artisans Summer Festival" 2024-06-15
 * among them — and every citation read `source_url: email://jtarboxme@gmail.com`,
 * `source_name: "Email body"`. The body contains no digits at all.
 *
 * ── Where the filed diagnosis and the code disagreed ──────────────────────
 *
 * The ticket read this as provenance threading: "the pipeline knows the URL and
 * discards it at citation-write time". `sourceIdentity()` already carries the
 * fetched URL for `kind: "url"`, and in prod all four events have
 * `source_url = NULL`, which only happens on the BODY path. So the citation was
 * not misattributing a scraped value — the body source really did emit it.
 *
 * The attribution was accurate. What it accurately attributed was a fabrication,
 * and the cause is one line upstream:
 *
 *     bodyHasSubstance = stripSignature(bodyTextRaw).trim().length > 20
 *
 * `"https://vineyardartisans.com/\n\n"` is 29 characters, so a body that was
 * nothing but a URL was handed to the LLM as an independent prose source. The
 * URL was ALREADY its own `kind:"url"` source in the same list, so that second
 * pass could contribute nothing — only hallucination surface.
 */
import { describe, expect, it } from "vitest";
import {
  bodyHasProseSubstance,
  proseRemainder,
} from "../src/email-handlers/body-prose-substance.js";
import { contradictedDateFields } from "../src/email-handlers/pipeline-citations.js";

const MV2_BODY = "https://vineyardartisans.com/\n\n";

describe("the body that produced three invented festivals", () => {
  it("is no longer treated as prose", () => {
    // 29 chars, clears the old >20 raw-length bar. Nothing is left once the URL
    // (already covered by its own url-source) is discounted.
    expect(MV2_BODY.trim().length).toBeGreaterThan(20); // the old test passed
    expect(bodyHasProseSubstance(MV2_BODY)).toBe(false); // the new one does not
  });

  it("leaves nothing behind after URL removal", () => {
    expect(proseRemainder(MV2_BODY)).toBe("");
  });

  it.each([
    ["bare url", "https://vineyardartisans.com/"],
    ["url + whitespace", "  https://vineyardartisans.com/  \n\n "],
    ["two urls", "https://a.example.com/one\nhttps://b.example.com/two"],
    ["www form", "www.vineyardartisans.com/festivals-and-events"],
    ["angle-bracketed", "<https://vineyardartisans.com/>"],
  ])("rejects a body that is only %s", (_label, body) => {
    expect(bodyHasProseSubstance(body)).toBe(false);
  });
});

describe("real prose is still extracted", () => {
  it("keeps the MV 1 body, which genuinely describes events", () => {
    // The counterpart email: prose WITH inline citation links. Cutting this
    // would lose real submissions, so it is the boundary that matters.
    const mv1 =
      "Explore craft fairs and festivals on Martha's Vineyard through events " +
      "like the weekly Vineyard Artisans Festivals at the Grange Hall in West " +
      "Tisbury (Thursdays and Sundays through summer). [1 " +
      "<https://vineyardartisans.com/>, 2 <https://www.marthasvisit.com/summer-events>";
    expect(bodyHasProseSubstance(mv1)).toBe(true);
  });

  it("keeps a short but real description", () => {
    expect(bodyHasProseSubstance("Harvest Fair, Sept 12-14 at the Grange Hall.")).toBe(true);
  });

  it("keeps prose that merely mentions a link", () => {
    expect(
      bodyHasProseSubstance("Our fair runs August 15-18 this year, details at https://x.example/")
    ).toBe(true);
  });
});

describe("the contradiction guard (scope 5)", () => {
  const dateFields = [
    { fieldName: "start_date", value: "2024-06-15" },
    { fieldName: "end_date", value: "2024-06-16" },
    { fieldName: "name", value: "Vineyard Artisans Summer Festival" },
  ];

  it("refuses date citations attributed to a body with no year in it", () => {
    expect(contradictedDateFields(dateFields, "body", MV2_BODY)).toEqual([
      "start_date",
      "end_date",
    ]);
  });

  it("never touches the name citation", () => {
    // The name IS derivable from the URL text, and dropping good provenance to
    // punish a bad neighbour would lose real information.
    expect(contradictedDateFields(dateFields, "body", MV2_BODY)).not.toContain("name");
  });

  it("allows dates when the body does mention a year", () => {
    // Deliberately permissive: this guard must not become a second extractor.
    // Any year present is enough to make the attribution plausible.
    expect(contradictedDateFields(dateFields, "body", "The 2024 fair runs in June")).toEqual([]);
  });

  it("is inert for url sources", () => {
    // We do not retain the fetched page text, so we cannot judge it — and
    // asserting a contradiction we cannot check would be its own fabrication.
    expect(contradictedDateFields(dateFields, "url", "")).toEqual([]);
  });

  it("applies to attachment sources too", () => {
    // An OCR'd poster that produced no year cannot support a date either.
    expect(contradictedDateFields(dateFields, "attachment", "logo only")).toEqual([
      "start_date",
      "end_date",
    ]);
  });

  it("does not fire when there are no date fields", () => {
    expect(
      contradictedDateFields([{ fieldName: "name", value: "X" }], "body", "no digits")
    ).toEqual([]);
  });
});
