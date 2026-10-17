import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolveVendorCta,
  stickyBarLabel,
  type VendorCtaInput,
  type VendorCtaPromoter,
} from "@/lib/events/vendor-cta";
import { COMMUNITY_PROMOTER_ID } from "@/lib/promoters/resolve-from-source";

const organizer: VendorCtaPromoter = {
  id: "p-1",
  slug: "pttf-events",
  companyName: "PTTF Events",
  claimed: false,
  website: "https://pttf-events.com",
  contactEmail: "craftfair@pttf-events.com",
  contactPhone: "(603) 555-0100",
};

function input(over: Partial<VendorCtaInput> = {}): VendorCtaInput {
  return {
    applicationHref: null,
    applicationDeadline: null,
    promoter: organizer,
    promoterWebsiteHref: "https://pttf-events.com",
    signedIn: false,
    isVendor: false,
    hasExistingApplication: false,
    ...over,
  };
}

describe("resolveVendorCta — OPE-986 B2", () => {
  it("the PTTF specimen: signed out, unclaimed promoter, no application fields → A2 with the organizer contact", () => {
    expect(resolveVendorCta(input())).toEqual({
      kind: "organizer_contact",
      organizerName: "PTTF Events",
      websiteHref: "https://pttf-events.com",
      contactEmail: "craftfair@pttf-events.com",
      contactPhone: "(603) 555-0100",
    });
  });

  it("a signed-in vendor on an UNCLAIMED promoter does not get the in-app path", () => {
    const cta = resolveVendorCta(input({ signedIn: true, isVendor: true }));
    expect(cta.kind).toBe("organizer_contact");
  });

  it("a signed-in vendor on a CLAIMED promoter keeps the in-app path", () => {
    const cta = resolveVendorCta(
      input({ signedIn: true, isVendor: true, promoter: { ...organizer, claimed: true } })
    );
    expect(cta).toEqual({ kind: "in_app" });
  });

  it("an existing application keeps its status card even on an unclaimed promoter", () => {
    const cta = resolveVendorCta(
      input({ signedIn: true, isVendor: true, hasExistingApplication: true })
    );
    expect(cta).toEqual({ kind: "in_app" });
  });

  it("signed out on a claimed promoter with no organizer link → Login to Apply", () => {
    const cta = resolveVendorCta(input({ promoter: { ...organizer, claimed: true } }));
    expect(cta).toEqual({ kind: "login_to_apply" });
  });

  it("an organizer application link wins over login and A2", () => {
    const deadline = new Date("2026-11-01T12:00:00Z");
    for (const claimed of [false, true]) {
      const cta = resolveVendorCta(
        input({
          applicationHref: "https://pttf-events.com/apply",
          applicationDeadline: deadline,
          promoter: { ...organizer, claimed },
        })
      );
      expect(cta).toEqual({
        kind: "organizer_apply",
        href: "https://pttf-events.com/apply",
        deadline,
      });
    }
  });

  it("a placeholder promoter is never named as the organizer, and shows no contact", () => {
    for (const p of [
      { ...organizer, id: COMMUNITY_PROMOTER_ID, slug: "community-suggestions" },
      { ...organizer, id: "house", slug: "meet-me-at-the-fair" },
    ]) {
      // claimed=true on a placeholder must not open the in-app path either.
      for (const claimed of [false, true]) {
        const cta = resolveVendorCta(
          input({ signedIn: true, isVendor: true, promoter: { ...p, claimed } })
        );
        expect(cta).toEqual({
          kind: "organizer_contact",
          organizerName: null,
          websiteHref: null,
          contactEmail: null,
          contactPhone: null,
        });
      }
    }
  });

  it("no promoter at all is treated as a placeholder", () => {
    const cta = resolveVendorCta(input({ promoter: null, promoterWebsiteHref: null }));
    expect(cta.kind).toBe("organizer_contact");
    expect(cta).toMatchObject({ organizerName: null });
  });

  it("blank contact strings read as absent", () => {
    const cta = resolveVendorCta(
      input({ promoter: { ...organizer, contactEmail: "  ", contactPhone: "" } })
    );
    expect(cta).toMatchObject({ contactEmail: null, contactPhone: null });
  });

  it("a signed-in user with no vendor profile sees nothing, as before", () => {
    expect(resolveVendorCta(input({ signedIn: true }))).toEqual({ kind: "none" });
  });

  it("claimed must be exactly true — undefined (the lite-projection trap) reads as unclaimed", () => {
    const cta = resolveVendorCta(
      input({
        signedIn: true,
        isVendor: true,
        promoter: { ...organizer, claimed: undefined as unknown as boolean },
      })
    );
    expect(cta.kind).toBe("organizer_contact");
  });
});

describe("stickyBarLabel", () => {
  it("labels each CTA kind", () => {
    expect(stickyBarLabel({ kind: "in_app" })).toBe("Apply as Vendor");
    expect(stickyBarLabel({ kind: "login_to_apply" })).toBe("Login to Apply");
    expect(stickyBarLabel({ kind: "organizer_apply", href: "x", deadline: null })).toBe(
      "Selling at this fair?"
    );
    expect(stickyBarLabel({ kind: "none" })).toBeNull();
  });
});

describe("event page wiring (OPE-986)", () => {
  const page = readFileSync(join(process.cwd(), "src/app/events/[slug]/page.tsx"), "utf8");

  it("gates the in-app vendor card on the resolver, not on vendorInfo alone", () => {
    expect(page).toContain('{vendorInfo && vendorCta.kind === "in_app" && (');
  });

  it("reads claimed from getPromoterVendorContact, never from the lite projection", () => {
    expect(page).toMatch(/getPromoterVendorContact\(\s*getCloudflareDb\(\),/);
    expect(page).not.toMatch(/event\.promoter\??\.claimed/);
  });

  it("no longer renders Login to Apply unconditionally for signed-out readers", () => {
    expect(page).not.toContain('!session && <StickyApplyBar label="Login to Apply"');
    expect(page).not.toMatch(/\{!session && \(\s*<Card id="vendor-apply">/);
  });
});
