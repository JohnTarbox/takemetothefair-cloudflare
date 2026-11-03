/**
 * OPE-986 A2 — the rendered card carries John's approved copy (2026-10-17)
 * verbatim, and names an organizer only when there is a real one.
 */
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { VendorOrganizerCard } from "@/components/events/VendorOrganizerCard";

vi.mock("@/components/OutboundEventLink", () => ({
  OutboundEventLink: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

const text = (c: HTMLElement) => c.textContent?.replace(/\s+/g, " ").trim() ?? "";

describe("VendorOrganizerCard (OPE-986 A2)", () => {
  it("renders the approved A2 copy verbatim for a real organizer with a website", () => {
    const { container } = render(
      <VendorOrganizerCard
        eventName="PTTF Holiday Craft Fair"
        eventSlug="pttf-holiday-craft-fair"
        cta={{
          kind: "organizer_contact",
          organizerName: "PTTF Events",
          websiteHref: "https://pttf-events.com",
          contactEmail: "craftfair@pttf-events.com",
          contactPhone: "(603) 555-0100",
        }}
      />
    );
    const t = text(container);
    expect(t).toContain("Selling at this fair?");
    expect(t).toContain(
      "We don't have vendor application details for PTTF Holiday Craft Fair. Applications go to the organizer, not through Meet Me at the Fair — check PTTF Events's website."
    );
    expect(container.querySelector('a[href="mailto:craftfair@pttf-events.com"]')).not.toBeNull();
    expect(container.querySelector('a[href="tel:6035550100"]')).not.toBeNull();
    const site = container.querySelector('a[href="https://pttf-events.com"]');
    expect(site?.textContent).toContain("Visit organizer website");
    // The misread surface is gone from this card.
    expect(t).not.toContain("Login to Apply");
  });

  it("a placeholder promoter gets the A2 text with no organizer name, contact or link", () => {
    const { container } = render(
      <VendorOrganizerCard
        eventName="Some Fair"
        eventSlug="some-fair"
        cta={{
          kind: "organizer_contact",
          organizerName: null,
          websiteHref: null,
          contactEmail: null,
          contactPhone: null,
        }}
      />
    );
    expect(text(container)).toContain(
      "Applications go to the organizer, not through Meet Me at the Fair."
    );
    expect(text(container)).not.toContain("check");
    expect(container.querySelectorAll("a")).toHaveLength(0);
  });

  it("an organizer application link renders as Apply on the organizer's site, with its deadline", () => {
    const { container } = render(
      <VendorOrganizerCard
        eventName="Fair"
        eventSlug="fair"
        cta={{
          kind: "organizer_apply",
          href: "https://example.org/apply",
          deadline: new Date("2099-03-01T12:00:00Z"),
        }}
      />
    );
    const link = container.querySelector('a[href="https://example.org/apply"]');
    expect(link?.textContent).toContain("Apply on the organizer's site");
    expect(text(container)).toContain("Deadline:");
    expect(text(container)).not.toContain("(Passed)");
  });
});
