"use client";

import { SessionProvider } from "next-auth/react";
import { ThemeProvider } from "next-themes";
import { FavoritesProvider } from "@/components/FavoritesProvider";
import { useCspNonce } from "@/components/security/nonce-script";
// OPE-1380 — side effect: stop zod's blocked `Function("")` eval probe.
import "@/lib/validations/zod-jitless";

export function Providers({ children }: { children: React.ReactNode }) {
  const nonce = useCspNonce();
  return (
    // Design System keystone — dark mode UNLOCKED (2026-06-07).
    //
    // History:
    //   - PR #383 shipped the .dark palette + ThemeToggle.
    //   - The MMATF-UIUX-DarkMode-Punchlist-2026-06.md audit caught
    //     that brand-color Tailwind utilities (text-navy / bg-amber /
    //     etc.) didn't theme (logo invisible at 1.16:1, etc.). PR
    //     #385 added `forcedTheme="light"` as next-themes' kill-switch
    //     AND introduced brand-color CSS vars with dark counterparts.
    //   - PR #386 closed the 4 contrast-audit residuals: --border
    //     lifted to pass 3:1 UI threshold, --navy lifted, 8 inline
    //     bg-amber+text-{navy,amber-bg-fg} sites migrated to
    //     text-primary-foreground.
    //   - Analytical audit confirmed 38 pass / 0 real fail / 1
    //     theoretical fail with no codebase consumers.
    //
    // Restoring the original keystone PR 4 config:
    //   - attribute="class" pairs with tailwind.config.ts darkMode:'class'
    //   - defaultTheme="system" + enableSystem honors prefers-color-scheme
    //     on first paint when no explicit user preference exists
    //   - disableTransitionOnChange prevents CSS transitions from
    //     animating during theme swap
    //   - <html> in layout.tsx carries suppressHydrationWarning
    //     (required by next-themes' pre-hydration <script>)
    //
    // OPE-1380 — `nonce`: next-themes' no-flash inline <script> must carry the
    // per-request CSP nonce on the nonce routes or 'strict-dynamic' blocks it.
    // Undefined on cached public pages (no nonce, same markup as before).
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      nonce={nonce}
    >
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
