/**
 * OPE-1477 item 1 — the organizer contact sits ABOVE "Ask about this event",
 * shows only what the promoter row holds, and never names a placeholder.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveOrganizerContact, telHref, type VendorCtaPromoter } from "@/lib/events/vendor-cta";
import { COMMUNITY_PROMOTER_ID } from "@/lib/promoters/resolve-from-source";

// The acceptance specimen: Saco Main Street's real phone.
const saco: VendorCtaPromoter = {
  id: "p-saco",
  slug: "saco-main-street",
  companyName: "Saco Main Street",
  claimed: false,
  website: "https://sacomainstreet.org",
  contactEmail: null,
  contactPhone: "207-286-3546",
};

describe("resolveOrganizerContact", () => {
  it("state 1 — a promoter with a phone shows it, tappable", () => {
    const c = resolveOrganizerContact(saco, "https://sacomainstreet.org");
    expect(c).toEqual({
      name: "Saco Main Street",
      email: null,
      phone: "207-286-3546",
      websiteHref: "https://sacomainstreet.org",
    });
    expect(telHref(c!.phone!)).toBe("tel:2072863546");
  });

  it("state 2 — no email or phone shows the website only", () => {
    const c = resolveOrganizerContact({ ...saco, contactPhone: " " }, "https://sacomainstreet.org");
    expect(c).toEqual({
      name: "Saco Main Street",
      email: null,
      phone: null,
      websiteHref: "https://sacomainstreet.org",
    });
  });

  it("state 3 — a placeholder promoter shows no organizer block", () => {
    expect(
      resolveOrganizerContact({ ...saco, id: COMMUNITY_PROMOTER_ID }, "https://x.example")
    ).toBeNull();
    expect(
      resolveOrganizerContact({ ...saco, slug: "meet-me-at-the-fair" }, "https://x.example")
    ).toBeNull();
    expect(resolveOrganizerContact(null, null)).toBeNull();
  });

  it("a real promoter with nothing to reach them by shows no block (a bare name is not a contact)", () => {
    expect(resolveOrganizerContact({ ...saco, contactPhone: null }, null)).toBeNull();
  });

  it("telHref keeps a leading + and strips formatting", () => {
    expect(telHref("+1 (207) 286-3546 ")).toBe("tel:+12072863546");
  });
});

describe("event page wiring (OPE-1477)", () => {
  const page = readFileSync(join(process.cwd(), "src/app/events/[slug]/page.tsx"), "utf8");

  it("renders the organizer block ABOVE the unchanged Ask-about link, inside the question card", () => {
    const card = page.indexOf("Question about this event?</h3>");
    const block = page.indexOf("{organizerContact && (");
    const ask = page.indexOf("href={askAboutHref}");
    expect(card).toBeGreaterThan(0);
    expect(block).toBeGreaterThan(card);
    expect(ask).toBeGreaterThan(block);
    // OPE-1478: the button keeps its label and target.
    expect(page).toMatch(/href=\{askAboutHref\}[\s\S]{0,200}Ask about this event/);
  });

  it("resolves the contact from the promoter-row read, not the lite projection", () => {
    expect(page).toMatch(/resolveOrganizerContact\(ctaPromoter,/);
  });
});
