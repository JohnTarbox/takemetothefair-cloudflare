"use client";

import { trackEvent } from "@/lib/analytics";
import type { AnchorHTMLAttributes, ReactNode } from "react";

interface TrackedLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  eventAction?: string;
  eventCategory?: string;
  eventLabel?: string;
  children: ReactNode;
}

export function TrackedLink({
  eventAction = "click_external_link",
  eventCategory = "engagement",
  eventLabel,
  children,
  onClick,
  ...props
}: TrackedLinkProps) {
  return (
    <a
      {...props}
      onClick={(e) => {
        trackEvent(eventAction, {
          category: eventCategory,
          label: eventLabel || props.href || undefined,
        });
        onClick?.(e);
      }}
    >
      {children}
    </a>
  );
}
