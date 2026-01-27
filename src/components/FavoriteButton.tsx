"use client";

import { useState, useEffect, useTransition } from "react";
import { Heart } from "lucide-react";
import { useSession } from "next-auth/react";
import { cn } from "@/lib/utils";

type FavoritableType = "EVENT" | "VENUE" | "VENDOR" | "PROMOTER";

interface FavoriteButtonProps {
  type: FavoritableType;
  id: string;
  className?: string;
  size?: "sm" | "md" | "lg";
}

export function FavoriteButton({ type, id, className, size = "md" }: FavoriteButtonProps) {
  const { data: session, status } = useSession();
  const [isFavorited, setIsFavorited] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [isLoading, setIsLoading] = useState(true);

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

  // Check if item is favorited on mount
  useEffect(() => {
    if (status === "loading") return;
    if (!session?.user) {
      setIsLoading(false);
      return;
    }

    const checkFavorite = async () => {
      try {
        const response = await fetch(`/api/favorites?type=${type}`);
        if (response.ok) {
          const data = await response.json();
          const favorited = data.favorites.some(
            (fav: { favoritableId: string }) => fav.favoritableId === id
          );
          setIsFavorited(favorited);
        }
      } catch (error) {
        console.error("Error checking favorite status:", error);
      } finally {
        setIsLoading(false);
      }
    };

    checkFavorite();
  }, [type, id, session, status]);

  const toggleFavorite = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (!session?.user) {
      // Redirect to login
      window.location.href = "/login?callbackUrl=" + encodeURIComponent(window.location.pathname);
      return;
    }

    // Optimistic update
    const newState = !isFavorited;
    setIsFavorited(newState);

    startTransition(async () => {
      try {
        if (newState) {
          // Add favorite
          const response = await fetch("/api/favorites", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type, id }),
          });
          if (!response.ok) {
            setIsFavorited(false); // Revert on error
          }
        } else {
          // Remove favorite
          const response = await fetch(`/api/favorites?type=${type}&id=${id}`, {
            method: "DELETE",
          });
          if (!response.ok) {
            setIsFavorited(true); // Revert on error
          }
        }
      } catch (error) {
        console.error("Error toggling favorite:", error);
        setIsFavorited(!newState); // Revert on error
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
          isFavorited
            ? "fill-red-500 text-red-500"
            : "text-gray-500 hover:text-red-400"
        )}
      />
    </button>
  );
}
