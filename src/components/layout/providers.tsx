"use client";

import { SessionProvider } from "next-auth/react";
import { ThemeProvider } from "next-themes";
import { FavoritesProvider } from "@/components/FavoritesProvider";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    // Design System keystone PR 4 (2026-06-07) — ThemeProvider is
    // the outermost wrapper so the theme class on <html> exists
    // before any descendant component's hydration. Configuration:
    //   - attribute="class" pairs with tailwind.config.ts darkMode:'class'
    //     so `dark:` variants compose against the .dark selector.
    //   - defaultTheme="system" + enableSystem honors prefers-color-scheme
    //     on first paint when no explicit user preference exists.
    //   - disableTransitionOnChange prevents CSS transitions from animating
    //     during the theme swap (otherwise color transitions feel sluggish
    //     and FOUC-like). Pinned recommendation from next-themes docs.
    //   - <html> in layout.tsx carries `suppressHydrationWarning` —
    //     required because next-themes' pre-hydration <script> tag mutates
    //     the class attribute before React reconciles, which would
    //     otherwise emit a hydration mismatch warning.
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
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
