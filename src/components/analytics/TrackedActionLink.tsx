"use client";

import type { AnchorHTMLAttributes, ReactNode } from "react";
import { track } from "@/lib/analytics";
import type { TrackedEntityType } from "@/lib/analytics/event-sinks";

/**
 * OPE-392 Ask B — an anchor that reports the intent it represents.
 *
 * Exists because the pages carrying these links (`/events/[slug]`,
 * `/venues/[slug]`, `/vendors/[slug]`) are SERVER components and cannot attach
 * an onClick. This is the smallest client boundary that solves it: the anchor
 * itself, not the surrounding card.
 *
 * Distinct from `TrackedLink`, which fires a single uncategorised
 * `click_external_link` to GA4 only. That is the "lumped into GA4's generic
 * click" the ticket suspected, and it is why a directions probe returned zero
 * while the links were being clicked all along.
 *
 * The entity pair is REQUIRED, for the reason the whole ticket exists:
 * `entity_slug` was already a registered GA4 dimension and came back
 * `(not set)` on 96% of events, because an optional join key is an omitted
 * one. `track()` refuses an undeclared event name, so a new link cannot ship
 * without a sink declaration either.
 */
interface TrackedActionLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  /** Must be declared in TRACKED_EVENTS — `track()` throws otherwise. */
  event: "directions_click" | "outbound_website_click" | "contact_click";
  entityType: TrackedEntityType;
  entitySlug: string;
  /** `contact_click` only: which affordance was tapped. */
  method?: "phone" | "email";
  children: ReactNode;
}

export function TrackedActionLink({
  event,
  entityType,
  entitySlug,
  method,
  children,
  onClick,
  ...anchorProps
}: TrackedActionLinkProps) {
  return (
    <a
      {...anchorProps}
      onClick={(e) => {
        // Fire before the handler and before navigation. `sendBeacon` is
        // queued by the browser and survives the page going away, which is why
        // the beacon is the right primitive here and a fetch would not be.
        track(
          event,
          { entityType, entitySlug, ...(method ? { method } : {}) },
          {
            label: `${entityType}:${entitySlug}`,
            entity_type: entityType,
            entity_slug: entitySlug,
            ...(method ? { method } : {}),
          }
        );
        onClick?.(e);
      }}
    >
      {children}
    </a>
  );
}
