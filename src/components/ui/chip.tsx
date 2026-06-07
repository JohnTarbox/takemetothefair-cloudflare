/**
 * Chip primitive — design system keystone PR 2 (2026-06-07).
 *
 * Pill-shaped tag / category label. Used today as bare `<span>` with
 * inline classes across event-detail's tag rows, category landing
 * pages, and the events browse facets. PR 3 will sweep those callsites
 * to render this primitive instead.
 *
 * Variants:
 *   - `default` (neutral) — muted surface, body text.
 *   - `category` — consumes a category-accent CSS var by name. The
 *     accent shows as a thin left border (matches the current
 *     event-card accent-bar pattern from `src/lib/category-colors.ts`).
 *     PR 4 themes the accent via `.dark` automatically.
 *
 * Sizes:
 *   - `sm` (px-2 py-0.5 text-xs) — listing rows, dense facet UIs.
 *   - `md` (px-2.5 py-1 text-sm) — detail pages, default.
 *
 * Required props:
 *   - `accentName` is required on `variant="category"` so the var-name
 *     can't be misspelled at runtime; the union pins the 5 accent
 *     names defined in globals.css (PR 1's `--accent-*` set).
 */

import { forwardRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export type ChipSize = "sm" | "md";

export type CategoryAccent = "gold" | "terracotta" | "sage" | "navy-soft" | "stone";

type ChipBase = {
  size?: ChipSize;
  className?: string;
  children: ReactNode;
};

export type ChipProps =
  | (ChipBase & { variant?: "default"; accentName?: never })
  | (ChipBase & { variant: "category"; accentName: CategoryAccent });

const SIZE: Record<ChipSize, string> = {
  sm: "px-2 py-0.5 text-xs",
  md: "px-2.5 py-1 text-sm",
};

const BASE = "inline-flex items-center rounded-full font-medium bg-muted text-foreground";

const ACCENT_BORDER: Record<CategoryAccent, string> = {
  gold: "border-l-2 border-accent-gold",
  terracotta: "border-l-2 border-accent-terracotta",
  sage: "border-l-2 border-accent-sage",
  "navy-soft": "border-l-2 border-accent-navy-soft",
  stone: "border-l-2 border-accent-stone",
};

export const Chip = forwardRef<HTMLSpanElement, ChipProps>(function Chip(
  { size = "md", className, children, ...rest },
  ref
) {
  const accent =
    rest.variant === "category" && rest.accentName ? ACCENT_BORDER[rest.accentName] : "";
  return (
    <span ref={ref} className={cn(BASE, SIZE[size], accent, className)}>
      {children}
    </span>
  );
});
