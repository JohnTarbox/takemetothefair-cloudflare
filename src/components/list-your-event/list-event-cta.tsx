"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { track } from "@/lib/analytics";

/**
 * OPE-1559 — every "list your event free" entry point, one per placement.
 *
 * The placement is the metric: the OPE-1557 scorecard reads CTA clicks BY
 * PLACEMENT, so each call site names its own and no two share one. The set is
 * closed (a typo is a type error, not a new silent series).
 */
export type ListCtaPlacement =
  | "nav_desktop"
  | "nav_mobile"
  | "footer"
  | "event_page"
  | "state_page"
  | "state_facet_page";

export function ListEventCtaLink({
  placement,
  href = "/list-your-event",
  className,
  onClick,
  children,
}: {
  placement: ListCtaPlacement;
  href?: string;
  className?: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className={className}
      data-list-cta={placement}
      onClick={() => {
        // Tracking must never block or break the navigation it describes.
        try {
          track("list_cta_click", { placement, href });
        } catch {
          // noop
        }
        onClick?.();
      }}
    >
      {children}
    </Link>
  );
}
