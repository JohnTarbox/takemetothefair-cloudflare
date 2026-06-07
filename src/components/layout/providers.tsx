"use client";

import { SessionProvider } from "next-auth/react";
import { ThemeProvider } from "next-themes";
import { FavoritesProvider } from "@/components/FavoritesProvider";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    // Design System keystone follow-up (2026-06-07) —
    // `forcedTheme="light"` is next-themes' kill-switch: it overrides
    // any user preference, OS `prefers-color-scheme`, AND the in-header
    // ThemeToggle. The toggle still renders but does nothing.
    //
    // Why: the dark palette shipped in PR #383 themes the SEMANTIC
    // tokens (--background, --card, --foreground, --primary etc.)
    // but the BRAND-color Tailwind utilities (`text-navy`,
    // `text-amber-fg`, `bg-amber`, `text-royal`, ...) used in 60+
    // files still point at hardcoded hex in tailwind.config.ts and
    // don't theme. Result: invisible logo (text-navy on dark
    // background = 1.16:1), unreadable date badges (text-amber-fg
    // tuned for light bg = 2.73:1 on dark), broken links. Per the
    // MMATF-UIUX-DarkMode-Punchlist-2026-06.md punch-list, the
    // toggle is gated OFF until brand-color tokens get proper
    // dark-theme values.
    //
    // The brand-color CSS vars + .dark mappings are added in this
    // same PR (globals.css + tailwind.config.ts). Once an operator
    // audit confirms dark mode now passes AA across the listed
    // surfaces (homepage, event detail, event cards/browse, vendors,
    // vendor detail), a follow-up PR removes `forcedTheme` and
    // restores `defaultTheme="system" enableSystem` to unlock.
    <ThemeProvider attribute="class" forcedTheme="light" disableTransitionOnChange>
      <SessionProvider>
        {/*
         * Cohort 4 (2026-06-01) — wraps inside SessionProvider so
         * useSession works in FavoritesProvider. One favorites fetch
         * per type per page-load instead of one per FavoriteButton mount.
         * Drops /vendors round-trips from ~50 → 1 (DOMContentLoaded
         * ~4.3s → ~1s target per email).
         */}
        <FavoritesProvider>{children}</FavoritesProvider>
      </SessionProvider>
    </ThemeProvider>
  );
}
