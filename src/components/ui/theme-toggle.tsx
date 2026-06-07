"use client";

/**
 * ThemeToggle — design system keystone PR 4 (2026-06-07).
 *
 * Sun/moon toggle that flips between light and dark theme via next-themes.
 * Placed in the header (desktop nav row + mobile menu). Reads + writes
 * the resolved theme; honors `prefers-color-scheme` on first paint when
 * no explicit preference is set (configured in ProviderProvider with
 * defaultTheme="system" + enableSystem).
 *
 * ## Why the placeholder-before-mount pattern
 *
 * next-themes resolves the theme client-side AFTER hydration (the
 * resolved theme depends on cookie + prefers-color-scheme + matchMedia,
 * none of which exist during SSR). Rendering the actual sun/moon icon
 * during SSR would emit one icon, then potentially flip on hydration
 * → visible flash. The `mounted` gate renders a `null` (or a
 * placeholder of the same hit-area size) during SSR and the first
 * client tick, then the real icon swap happens. From the user's
 * perspective it's "the toggle just appeared at the right state" —
 * no visual flip.
 *
 * The placeholder uses an empty `<span>` with the same min-w/h as
 * IconButton's `size="md"` (40×40px) so header layout doesn't shift.
 */

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Sun, Moon } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";

export function ThemeToggle() {
  const [mounted, setMounted] = useState(false);
  const { resolvedTheme, setTheme } = useTheme();

  useEffect(() => {
    setMounted(true);
  }, []);

  // SSR + first-render placeholder — matches IconButton size="md" footprint
  // so no layout shift when the real toggle mounts.
  if (!mounted) {
    return <span className="inline-flex min-w-[40px] min-h-[40px]" aria-hidden="true" />;
  }

  const isDark = resolvedTheme === "dark";
  return (
    <IconButton
      size="md"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      icon={isDark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      aria-pressed={isDark}
    />
  );
}
