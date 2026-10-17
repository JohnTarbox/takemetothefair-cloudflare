/**
 * OPE-986 (ruled by John 2026-10-17: A2 + B2, merged with OPE-1477 item 2) —
 * which vendor call-to-action an event page shows.
 *
 * A crafter registered a vendor account from an event page believing he had
 * applied to that fair. Two things sent him there: a "Login to Apply" button on
 * every event, and an in-app application path that, on 50 of 51 rows, reached a
 * promoter who is not on the platform. So:
 *
 *  - B2: the in-app "Apply as Vendor" path shows ONLY when the event's promoter
 *    has claimed the listing — the one case where an application reaches anyone.
 *  - Otherwise the page says where applications actually go: the organizer's own
 *    application link when we hold one, or the A2 "Selling at this fair?" card
 *    with whatever organizer contact we hold. A placeholder promoter gets no
 *    organizer name or contact, because it is not an organizer.
 *
 * Pure, so the precedence is testable without rendering the page.
 */
import { COMMUNITY_PROMOTER_ID } from "@/lib/promoters/resolve-from-source";

/** The house promoter row: events we list ourselves, not an organizer. */
const HOUSE_PROMOTER_SLUG = "meet-me-at-the-fair";

export interface VendorCtaPromoter {
  id: string;
  slug: string;
  companyName: string;
  claimed: boolean | null;
  website: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
}

export interface VendorCtaInput {
  /** `safeHref`-checked organizer application link (events.application_url, or
   *  a commercial_vendor `event_applications` row). NULL when we hold none. */
  applicationHref: string | null;
  applicationDeadline: Date | null;
  promoter: VendorCtaPromoter | null;
  /** `safeHref`-checked promoter website. */
  promoterWebsiteHref: string | null;
  signedIn: boolean;
  /** The signed-in user has a vendor profile. */
  isVendor: boolean;
  /** That vendor already has an `event_vendors` row here — its status card
   *  stays, whoever the promoter is. */
  hasExistingApplication: boolean;
}

export type VendorCta =
  /** Signed-in vendor, claimed promoter: the existing in-app application card. */
  | { kind: "in_app" }
  /** Signed out, claimed promoter, no organizer link: in-app path via login. */
  | { kind: "login_to_apply" }
  /** We hold the organizer's own application link. */
  | { kind: "organizer_apply"; href: string; deadline: Date | null }
  /** A2 — we hold no application details; say so, and who to ask. */
  | {
      kind: "organizer_contact";
      /** NULL for a placeholder promoter — never name it as the organizer. */
      organizerName: string | null;
      websiteHref: string | null;
      contactEmail: string | null;
      contactPhone: string | null;
    }
  /** Signed in without a vendor profile: nothing, as before. */
  | { kind: "none" };

export function isPlaceholderPromoter(p: Pick<VendorCtaPromoter, "id" | "slug">): boolean {
  return p.id === COMMUNITY_PROMOTER_ID || p.slug === HOUSE_PROMOTER_SLUG;
}

export function resolveVendorCta(input: VendorCtaInput): VendorCta {
  if (input.signedIn && !input.isVendor) return { kind: "none" };
  if (input.signedIn && input.hasExistingApplication) return { kind: "in_app" };

  const promoter = input.promoter;
  const placeholder = !promoter || isPlaceholderPromoter(promoter);
  const promoterClaimed = !placeholder && promoter.claimed === true;

  // B2 — a signed-in vendor gets the in-app path only where it reaches someone.
  if (input.signedIn && promoterClaimed) return { kind: "in_app" };

  if (input.applicationHref) {
    return {
      kind: "organizer_apply",
      href: input.applicationHref,
      deadline: input.applicationDeadline,
    };
  }

  if (!input.signedIn && promoterClaimed) return { kind: "login_to_apply" };

  if (placeholder) {
    return {
      kind: "organizer_contact",
      organizerName: null,
      websiteHref: null,
      contactEmail: null,
      contactPhone: null,
    };
  }
  return {
    kind: "organizer_contact",
    organizerName: promoter.companyName,
    websiteHref: input.promoterWebsiteHref,
    contactEmail: promoter.contactEmail?.trim() || null,
    contactPhone: promoter.contactPhone?.trim() || null,
  };
}

/** The mobile sticky-bar label for a resolved CTA (NULL = no bar). */
export function stickyBarLabel(cta: VendorCta): string | null {
  switch (cta.kind) {
    case "in_app":
      return "Apply as Vendor";
    case "login_to_apply":
      return "Login to Apply";
    case "organizer_apply":
    case "organizer_contact":
      return "Selling at this fair?";
    case "none":
      return null;
  }
}
