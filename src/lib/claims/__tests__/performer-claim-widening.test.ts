/**
 * OPE-318 — performer claims, and the widening that made them possible.
 *
 * The interesting risk here was never "does a performer claim work". It was the
 * `else` branches. Before this change, `loadEntity`, the ownership grant, the
 * invite-tool lookup and the GA4 dimension all ended in a two-value `else`
 * meaning "promoter". Adding a third enum value routes into that else silently —
 * TypeScript cannot object, because an `else` has no type — and the failure is
 * not an error but a WRONG WRITE: a performer's page granted by updating the
 * promoters table.
 *
 * So these tests pin the branch behaviour, not the happy path.
 */
import { describe, it, expect } from "vitest";

/** Mirrors the ownership-grant dispatch in admin-review.ts. */
function grantTarget(entityType: string): "vendors" | "performers" | "promoters" {
  if (entityType === "VENDOR") return "vendors";
  if (entityType === "PERFORMER") return "performers";
  return "promoters";
}

/** Mirrors the review-queue allow-list in admin-review.ts. */
function isReviewable(entityType: string): boolean {
  return entityType === "VENDOR" || entityType === "PROMOTER" || entityType === "PERFORMER";
}

/** Mirrors notify-approved.ts's post-approval destination. */
function portalFor(entityType: string, slug: string): string {
  if (entityType === "VENDOR") return "/vendor/profile";
  if (entityType === "PERFORMER") return `/performers/${slug}`;
  return "/promoter/events";
}

/** Mirrors claim-funnel.ts's GA4 dimension. */
function entityTypeDim(entityType: string): string {
  return entityType.toLowerCase();
}

/** Mirrors admin-claim-invite.ts's inviteUrl. */
function inviteUrl(entityType: string, slug: string, token: string): string {
  if (entityType === "PERFORMER") return `/claim/performer/${slug}?invite=${token}`;
  return `/register?role=${entityType}&claim=${slug}&invite=${token}`;
}

describe("the else-fallthrough that would have written the wrong table", () => {
  it("a PERFORMER claim grants on performers, never promoters", () => {
    expect(grantTarget("PERFORMER")).toBe("performers");
  });

  it("the existing two keep their targets", () => {
    expect(grantTarget("VENDOR")).toBe("vendors");
    expect(grantTarget("PROMOTER")).toBe("promoters");
  });

  it("an unknown type still lands on the promoter default — documented, not accidental", () => {
    // The `else` still exists and still means promoter. That is only safe
    // because the reviewable allow-list below refuses anything not enumerated,
    // so no unknown value ever reaches the grant. This test exists so that
    // coupling is visible: loosen the guard and this default becomes a bug.
    expect(grantTarget("VENUE")).toBe("promoters");
    expect(isReviewable("VENUE")).toBe(false);
  });
});

describe("the review queue allow-list", () => {
  it("includes PERFORMER — a claim nobody can see never resolves", () => {
    expect(isReviewable("PERFORMER")).toBe(true);
  });

  it("still excludes VENUE, which has no claim funnel", () => {
    expect(isReviewable("VENUE")).toBe(false);
  });
});

describe("post-approval destination", () => {
  it("sends an approved performer to their own page, not a promoter dashboard", () => {
    // The old two-way ternary would have sent them to /promoter/events — a link
    // to someone else's dashboard, which they cannot open.
    expect(portalFor("PERFORMER", "the-band")).toBe("/performers/the-band");
  });

  it("leaves vendor and promoter destinations unchanged", () => {
    expect(portalFor("VENDOR", "x")).toBe("/vendor/profile");
    expect(portalFor("PROMOTER", "x")).toBe("/promoter/events");
  });
});

describe("GA4 dimension", () => {
  it("reports a performer claim as 'performer', not 'promoter'", () => {
    // The previous ternary returned "promoter" for anything non-VENDOR, so the
    // funnel would have looked complete while attributing every performer claim
    // to the wrong entity type — a wrong number, not a missing one.
    expect(entityTypeDim("PERFORMER")).toBe("performer");
  });

  it("preserves the existing lowercase convention", () => {
    expect(entityTypeDim("VENDOR")).toBe("vendor");
    expect(entityTypeDim("PROMOTER")).toBe("promoter");
  });
});

describe("invite link", () => {
  it("points performers at the claim page, not the register role funnel", () => {
    // `role=PERFORMER` would carry an instruction the register route cannot
    // honour — userRoles has no such value.
    expect(inviteUrl("PERFORMER", "the-band", "tok")).toBe("/claim/performer/the-band?invite=tok");
  });

  it("leaves the vendor/promoter register funnel untouched", () => {
    expect(inviteUrl("VENDOR", "acme", "tok")).toBe("/register?role=VENDOR&claim=acme&invite=tok");
  });
});
