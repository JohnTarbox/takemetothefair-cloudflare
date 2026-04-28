"use client";

import type { AnchorHTMLAttributes, ReactNode } from "react";
import { trackOutboundApplicationClick, trackOutboundTicketClick } from "@/lib/analytics";

interface OutboundEventLinkProps extends Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "children" | "onClick"
> {
  href: string;
  kind: "application" | "ticket";
  eventSlug: string;
  children: ReactNode;
}

export function OutboundEventLink({
  href,
  kind,
  eventSlug,
  children,
  ...rest
}: OutboundEventLinkProps) {
  return (
    <a
      {...rest}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={() => {
        if (kind === "application") {
          trackOutboundApplicationClick(eventSlug, href);
        } else {
          trackOutboundTicketClick(eventSlug, href);
        }
      }}
    >
      {children}
    </a>
  );
}
