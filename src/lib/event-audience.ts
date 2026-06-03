/**
 * TAX1 Phase 3 (2026-06-02). Composes the audience/access badge that
 * surfaces on the event detail page and the event card.
 *
 * Two orthogonal axes from drizzle/0100:
 *   primary_audience: PUBLIC | TRADE  | MEMBERS
 *   public_access:    OPEN   | CLOSED
 *
 * The dev-email's A2 scenario table maps the 6 combinations to user-
 * facing labels. The default (PUBLIC + OPEN) intentionally returns
 * null so the badge area stays clutter-free for the majority of
 * events.
 *
 * Vendor-side ranking does NOT consume this. Per A5 of the dev email,
 * MEMBERS / TRADE events are informational, never a down-rank input —
 * restricted-audience + exhibitor-floor + matching demographic is a
 * known-good pattern (LeafFilter × MAR). See the JSDoc guard comment
 * in src/lib/recommendations/tiers.ts for the belt-and-braces note.
 */

import type { PrimaryAudience, PublicAccess } from "@takemetothefair/constants";

export type AudienceBadgeVariant = "info" | "warning" | "default";

export interface AudienceBadge {
  /** User-facing label string (matches the dev-email A2 scenario table). */
  label: string;
  /** Badge variant for the existing <Badge> component in src/components/ui/badge.tsx. */
  variant: AudienceBadgeVariant;
  /** A short machine-readable key for analytics + the recommendations
   *  ranking guard. Mirrors the dev-email scenario names. */
  key: "trade_closed" | "trade_open_paid" | "members_closed" | "members_open" | "public_closed";
}

/**
 * Compose the badge for an event's audience/access pair.
 *
 * Returns null when the event is the permissive default (PUBLIC +
 * OPEN). The caller renders nothing in that case — the badge area
 * stays uncluttered for ~95% of events per the audit estimate.
 *
 * `accessNotes` is consulted only in the MEMBERS + OPEN case to
 * disambiguate the label ("Members event — public welcome for [X]").
 * When notes are absent, falls back to a generic public-welcome
 * label.
 */
export function formatAudienceBadge(
  primaryAudience: PrimaryAudience | null | undefined,
  publicAccess: PublicAccess | null | undefined,
  accessNotes?: string | null
): AudienceBadge | null {
  // Treat missing values as the default. A migration-old row reads
  // as PUBLIC/OPEN once the 0100 ALTER applies its column defaults;
  // this null-coalescing handles the brief window between deploy and
  // backfill on any path that bypassed the column read.
  const aud: PrimaryAudience = primaryAudience ?? "PUBLIC";
  const acc: PublicAccess = publicAccess ?? "OPEN";

  // Default permissive: no badge.
  if (aud === "PUBLIC" && acc === "OPEN") return null;

  // PUBLIC + CLOSED — rare; an event marked public-facing but
  // currently not accepting attendees (e.g. sold out, cancelled).
  // The CANCELLED / TENTATIVE lifecycle badges already cover the
  // primary case; this one's the edge case that the data lets us
  // express.
  if (aud === "PUBLIC" && acc === "CLOSED") {
    return {
      label: "Not currently open to attendees",
      variant: "warning",
      key: "public_closed",
    };
  }

  // TRADE — orientation-toward-industry. The OPEN variant says
  // "public may pay in" (Maine PHCC Expo — see A2 of the dev email);
  // the CLOSED variant says strictly credential-gated.
  if (aud === "TRADE" && acc === "CLOSED") {
    return {
      label: "Trade only — not open to the public",
      variant: "info",
      key: "trade_closed",
    };
  }
  if (aud === "TRADE" && acc === "OPEN") {
    return {
      label: "Industry trade show — public welcome",
      variant: "info",
      key: "trade_open_paid",
    };
  }

  // MEMBERS — orientation-toward-membership (associations / clubs).
  // OPEN variant supports the "members convention + plant sale"
  // pattern (A9); CLOSED is the strict members-only meeting.
  if (aud === "MEMBERS" && acc === "CLOSED") {
    return {
      label: "Members only",
      variant: "default",
      key: "members_closed",
    };
  }
  if (aud === "MEMBERS" && acc === "OPEN") {
    // When access_notes carry a short hint, surface it in the label
    // so casual readers don't have to scroll to the description.
    const trimmedNotes = accessNotes?.trim();
    const suffix = trimmedNotes && trimmedNotes.length < 50 ? ` — ${trimmedNotes}` : "";
    return {
      label: `Members event — public welcome${suffix}`,
      variant: "info",
      key: "members_open",
    };
  }

  // Exhaustive fall-through (TS narrows to never above; this is
  // defensive against schema additions).
  return null;
}

/**
 * Used by EventSchema.tsx to decide whether to emit the schema.org
 * `audience` block AND whether to suppress `offers`. Returns true for
 * CLOSED events of any audience.
 *
 * The `offers` suppression is the SEO accuracy lever (A7). Emitting
 * `offers` on a CLOSED event would tell Google "this is bookable by
 * anyone for $X" — the exact harm this feature exists to prevent.
 */
export function isClosedToPublic(publicAccess: PublicAccess | null | undefined): boolean {
  return (publicAccess ?? "OPEN") === "CLOSED";
}

/**
 * Used by EventSchema.tsx to decide whether to emit `audience`.
 * Returns true for any non-default audience/access pair.
 */
export function hasNonDefaultAudience(
  primaryAudience: PrimaryAudience | null | undefined,
  publicAccess: PublicAccess | null | undefined
): boolean {
  return (primaryAudience ?? "PUBLIC") !== "PUBLIC" || (publicAccess ?? "OPEN") !== "OPEN";
}
