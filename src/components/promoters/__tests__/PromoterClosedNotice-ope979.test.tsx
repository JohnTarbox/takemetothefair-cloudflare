/**
 * OPE-979 — the "No longer operating" notice, John-approved copy (2026-09-30),
 * and the rule that hides the claim prompt on a closed business.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PromoterClosedNotice } from "../PromoterClosedNotice";
import { isClosedPromoter } from "@/lib/promoters/operating-status";

describe("isClosedPromoter", () => {
  it.each([
    ["CEASED", true],
    ["MERGED", true],
    ["ACTIVE", false],
    ["UNKNOWN", false],
    [null, false],
    [undefined, false],
  ])("%s → %s", (status, want) => {
    expect(isClosedPromoter(status)).toBe(want);
  });
});

describe("PromoterClosedNotice", () => {
  it("with a successor: names it and links its page (the Eagle Shows case)", () => {
    const html = renderToStaticMarkup(
      <PromoterClosedNotice
        companyName="Eagle Shows"
        successor={{ companyName: "Eastern Gun Expo", slug: "eastern-gun-expo" }}
      />
    );
    expect(html).toContain("No longer operating");
    expect(html).toContain("Eagle Shows has closed. Its shows are now run by");
    expect(html).toContain("<strong>Eastern Gun Expo</strong>");
    expect(html).toContain('href="/promoters/eastern-gun-expo"');
  });

  it("without a successor: the plain copy, no link", () => {
    const html = renderToStaticMarkup(
      <PromoterClosedNotice companyName="Ledyard Fair" successor={null} />
    );
    expect(html).toContain(
      "Ledyard Fair is no longer operating. Past events are listed below for reference."
    );
    expect(html).not.toContain("href=");
  });
});
