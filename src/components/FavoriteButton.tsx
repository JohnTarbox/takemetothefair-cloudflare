"use client";

import { useTransition } from "react";
import { Heart } from "lucide-react";
import { useSession } from "next-auth/react";
import { trackEvent } from "@/lib/analytics";
import { cn } from "@/lib/utils";
import { useFavorites } from "@/components/FavoritesProvider";
import { IconButton } from "@/components/ui/icon-button";

type FavoritableType = "EVENT" | "VENUE" | "VENDOR" | "PROMOTER";

interface FavoriteButtonProps {
  type: FavoritableType;
  id: string;
  className?: string;
  size?: "sm" | "md" | "lg";
}

export function FavoriteButton({ type, id, className, size = "md" }: FavoriteButtonProps) {
  // Cohort 4 (2026-06-01) — pull favorited state from per-page
  // FavoritesProvider cache instead of fetching on every mount. One
  // fetch per type per page-load, shared across all FavoriteButtons.
  // Per-button POST/DELETE is unchanged — only the read path is shared.
  //
  // U7 / Phase D (2026-06-02) — replaced the raw <button> + padding-only
  // sizing with the IconButton primitive (src/components/ui/icon-button.tsx)
  // so the hit-area floor is enforced at the type level (min-w/min-h
  // 32/40/44px for sm/md/lg) rather than only padding-derived. Tailwind's
  // twMerge collapses IconButton's base `rounded-lg` against the
  // `rounded-full` we pass via className so the pill silhouette is
  // preserved. WCAG 2.2 AA 2.5.8.
  const { data: session, status } = useSession();
  const { isFavorited: favCheck, setFavorited, isLoadingType } = useFavorites();
  const isFavorited = favCheck(type, id);
  const [isPending, startTransition] = useTransition();
  // Show the loading shimmer only while the very first fetch for this
  // type is in flight AND we have a session (logged-out users have
  // nothing to load). Avoids the briefly-disabled flash on subsequent
  // mounts that hit the warm cache.
  const isLoading = status === "loading" || (!!session?.user && isLoadingType(type));

  // Heart-icon visual size — kept at one step larger than the
  // IconButton wrapper's ICON_SIZE so the heart silhouette stays
  // the same visual weight as the pre-U7 button (which used
  // w-5/w-6/w-7 directly). The IconButton wrapper centers via
  // flex without clipping, so the slightly-larger inner SVG
  // simply renders at its own size on top of the centered span.
  const heartSizeClasses = {
    sm: "w-5 h-5",
    md: "w-6 h-6",
    lg: "w-7 h-7",
  };

  const toggleFavorite = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (!session?.user) {
      // Redirect to login
      window.location.href = "/login?callbackUrl=" + encodeURIComponent(window.location.pathname);
      return;
    }

    // Optimistic update — write the new state straight into the
    // shared cache. Every FavoriteButton subscribed to the same
    // (type, id) re-renders with the new heart fill.
    const newState = !isFavorited;
    setFavorited(type, id, newState);
    trackEvent("favorite_toggle", { category: "engagement", label: `${type}:${id}` });

    startTransition(async () => {
      try {
        if (newState) {
          const response = await fetch("/api/favorites", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type, id }),
          });
          if (!response.ok) {
            setFavorited(type, id, false); // Revert on error
          }
        } else {
          const response = await fetch(`/api/favorites?type=${type}&id=${id}`, {
            method: "DELETE",
          });
          if (!response.ok) {
            setFavorited(type, id, true); // Revert on error
          }
        }
      } catch (error) {
        console.error("Error toggling favorite:", error);
        setFavorited(type, id, !newState); // Revert on error
      }
    });
  };

  // Single IconButton render — branching only over the loading vs
  // active visual treatment, keeping aria-label/onClick/disabled
  // wiring co-located.
  const ariaLabel = isLoading
    ? "Loading favorites"
    : isFavorited
      ? "Remove from favorites"
      : "Add to favorites";

  return (
    <IconButton
      aria-label={ariaLabel}
      size={size}
      variant="ghost"
      onClick={isLoading ? undefined : toggleFavorite}
      disabled={isLoading || isPending}
      title={isLoading ? undefined : ariaLabel}
      className={cn(
        // Pill silhouette + card affordance. twMerge collapses the
        // base `rounded-lg` from IconButton in favor of rounded-full.
        "rounded-full bg-white shadow-md border border-gray-200 transition-all",
        !isLoading && "hover:shadow-lg hover:scale-110",
        isPending && "opacity-50 cursor-wait",
        className
      )}
      icon={
        <Heart
          className={cn(
            heartSizeClasses[size],
            "transition-colors",
            isLoading
              ? "text-gray-300"
              : isFavorited
                ? "fill-red-500 text-red-500"
                : "text-gray-500 hover:text-red-400"
          )}
        />
      }
    />
  );
}
