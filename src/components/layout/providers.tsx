"use client";

import { SessionProvider } from "next-auth/react";
import { FavoritesProvider } from "@/components/FavoritesProvider";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
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
  );
}
