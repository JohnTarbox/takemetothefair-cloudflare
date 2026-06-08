"use client";

/**
 * Shared icon-only button + link primitives with REQUIRED aria-label.
 *
 * Cohort 5 (analyst, 2026-06-01). Solves two WCAG issues at once via
 * the type system:
 *   - WCAG 4.1.2 (icon-only controls need an accessible name): the
 *     aria-label prop is non-optional, so the primitive can't compile
 *     without one. Catches the next equivalent at PR review time
 *     rather than via an axe-core run after deploy.
 *   - WCAG 2.2 AA 2.5.8 (target size ≥ 24px): size="sm" sets a
 *     min-w/min-h-[40px] hit area with a 16px icon centered inside.
 *     Even "sm" clears the 24px threshold (we picked 40 to match
 *     touch-target guidance for primary actions; a future
 *     size="xs" could tighten to 24 for dense admin tables).
 *
 * Sibling IconLink wraps next/link with the same required-aria-label
 * contract. Use it for navigations (e.g. /admin/events row actions);
 * use IconButton for state changes.
 *
 * The required aria-label prop is the key design choice — it has to
 * stay non-optional for the lint guard at PR review to work. Removing
 * the requirement would silently regress the WCAG fix.
 */

import { ButtonHTMLAttributes, forwardRef, ReactNode } from "react";
import Link, { LinkProps } from "next/link";
import { cn } from "@/lib/utils";

export type IconButtonSize = "sm" | "md" | "lg";
export type IconButtonVariant = "ghost" | "solid" | "danger";

// Tailwind class maps — kept module-level so the primitive is
// tree-shakeable and the strings end up in tailwind's content scan.
// All three sizes clear the WCAG 2.2 AA 24px hit-target floor.
const HIT_AREA: Record<IconButtonSize, string> = {
  sm: "min-w-[32px] min-h-[32px] p-1.5",
  md: "min-w-[40px] min-h-[40px] p-2",
  lg: "min-w-[44px] min-h-[44px] p-2.5",
};

const ICON_SIZE: Record<IconButtonSize, string> = {
  sm: "w-4 h-4",
  md: "w-5 h-5",
  lg: "w-6 h-6",
};

// Design System keystone PR 2 (2026-06-07) — token migration.
// - `ghost` (default) is the neutral icon-on-surface treatment for
//   header/toolbar icons. Maps to muted-foreground content + muted
//   hover bg.
// - `solid` retains the royal/navy brand pattern but routes through
//   semantic tokens: bg-primary (amber brand) is reserved for primary
//   CTAs; the solid IconButton variant uses bg-secondary (navy) since
//   the original was bg-royal hover:bg-secondary/90. --secondary-foreground
//   provides the AAA white text on navy.
// - `danger` migrates to --destructive (the shadcn-convention name).
const VARIANT: Record<IconButtonVariant, string> = {
  ghost: "text-muted-foreground hover:bg-muted hover:text-foreground",
  solid: "bg-secondary text-secondary-foreground hover:bg-secondary/85 shadow-sm",
  danger: "text-destructive hover:bg-destructive/10 hover:text-destructive",
};

// Common to button + link. inline-flex centers the icon; rounded
// matches existing button styles; focus-visible ring uses --ring
// (token equivalent of the prior `royal/40` literal).
const BASE_CLASSES =
  "inline-flex items-center justify-center rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50 disabled:cursor-not-allowed";

interface IconButtonOwnProps {
  /** Required for screen readers. Always required by the type — the
   *  primitive's whole point is making icon-only buttons named. */
  "aria-label": string;
  /** Lucide-React or other inline SVG. Wrap with aria-hidden="true"
   *  in your call site to avoid double-announcement; the wrapper
   *  already has the label. */
  icon: ReactNode;
  size?: IconButtonSize;
  variant?: IconButtonVariant;
}

export type IconButtonProps = IconButtonOwnProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "children">;

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, size = "md", variant = "ghost", className, type = "button", ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(BASE_CLASSES, HIT_AREA[size], VARIANT[variant], className)}
      {...rest}
    >
      <span className={cn(ICON_SIZE[size], "flex items-center justify-center")} aria-hidden="true">
        {icon}
      </span>
    </button>
  );
});

// IconLink — same contract but renders as <Link>. Used for navigation
// row-actions (edit / view) where a real anchor is the right element.
// `LinkProps` covers `href` + Next.js prefetch / replace etc.; we
// drop `children` (icon goes in via the `icon` prop) and `aria-label`
// (made required by IconButtonOwnProps).
type AnchorAttrs = Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, keyof LinkProps>;
export type IconLinkProps = IconButtonOwnProps &
  LinkProps &
  Omit<AnchorAttrs, "aria-label" | "children">;

export function IconLink({
  icon,
  size = "md",
  variant = "ghost",
  className,
  ...rest
}: IconLinkProps) {
  return (
    <Link className={cn(BASE_CLASSES, HIT_AREA[size], VARIANT[variant], className)} {...rest}>
      <span className={cn(ICON_SIZE[size], "flex items-center justify-center")} aria-hidden="true">
        {icon}
      </span>
    </Link>
  );
}
