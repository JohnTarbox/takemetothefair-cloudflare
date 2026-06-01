"use client";

import { useTransition } from "react";
import { Heart } from "lucide-react";
import { useSession } from "next-auth/react";
import { trackEvent } from "@/lib/analytics";
import { cn } from "@/lib/utils";
import { useFavorites } from "@/components/FavoritesProvider";

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
  const { data: session, status } = useSession();
  const { isFavorited: favCheck, setFavorited, isLoadingType } = useFavorites();
  const isFavorited = favCheck(type, id);
  const [isPending, startTransition] = useTransition();
  // Show the loading shimmer only while the very first fetch for this
  // type is in flight AND we have a session (logged-out users have
  // nothing to load). Avoids the briefly-disabled flash on subsequent
  // mounts that hit the warm cache.
  const isLoading = status === "loading" || (!!session?.user && isLoadingType(type));

  const sizeClasses = {
    sm: "w-5 h-5",
    md: "w-6 h-6",
    lg: "w-7 h-7",
  };

  const buttonSizeClasses = {
    sm: "p-1.5",
    md: "p-2",
    lg: "p-2.5",
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

  if (isLoading) {
    return (
      <button
        className={cn(
          "rounded-full bg-white shadow-md border border-gray-200 transition-all",
          buttonSizeClasses[size],
          className
        )}
        disabled
      >
        <Heart className={cn(sizeClasses[size], "text-gray-300")} />
      </button>
    );
  }

  return (
    <button
      onClick={toggleFavorite}
      disabled={isPending}
      className={cn(
        "rounded-full bg-white shadow-md border border-gray-200 hover:shadow-lg transition-all hover:scale-110",
        buttonSizeClasses[size],
        isPending && "opacity-50 cursor-wait",
        className
      )}
      title={isFavorited ? "Remove from favorites" : "Add to favorites"}
    >
      <Heart
        className={cn(
          sizeClasses[size],
          "transition-colors",
          isFavorited ? "fill-red-500 text-red-500" : "text-gray-500 hover:text-red-400"
        )}
      />
    </button>
  );
}
