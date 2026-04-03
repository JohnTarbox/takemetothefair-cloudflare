"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Search, MapPin, Loader2, Link2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PlaceLookupResult } from "@/lib/google-maps";

interface AutocompleteSuggestion {
  placeId: string;
  mainText: string;
  secondaryText: string;
  fullText: string;
}

interface GooglePlaceSearchProps {
  onPlaceSelect: (place: PlaceLookupResult) => void;
  showUrlInput?: boolean;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

export function GooglePlaceSearch({
  onPlaceSelect,
  showUrlInput = false,
  placeholder = "Search for a place on Google...",
  disabled = false,
  className,
}: GooglePlaceSearchProps) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<AutocompleteSuggestion[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingPlace, setLoadingPlace] = useState(false);
  const [error, setError] = useState("");
  const [showUrl, setShowUrl] = useState(showUrlInput);
  const [urlValue, setUrlValue] = useState("");
  const [resolvingUrl, setResolvingUrl] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounced autocomplete
  useEffect(() => {
    if (query.length < 2) {
      setSuggestions([]);
      setIsOpen(false);
      return;
    }

    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/venues/google-autocomplete?q=${encodeURIComponent(query)}`
        );
        if (res.ok) {
          const data = (await res.json()) as {
            suggestions: AutocompleteSuggestion[];
          };
          setSuggestions(data.suggestions);
          setIsOpen(data.suggestions.length > 0);
        }
      } catch {
        // Silently fail autocomplete
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [query]);

  // Click outside to close
  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, []);

  const selectSuggestion = useCallback(
    async (suggestion: AutocompleteSuggestion) => {
      setIsOpen(false);
      setQuery(suggestion.mainText);
      setLoadingPlace(true);
      setError("");

      try {
        const res = await fetch(
          `/api/venues/google-place-details?placeId=${encodeURIComponent(suggestion.placeId)}`
        );
        if (!res.ok) {
          const data = (await res.json()) as { error?: string };
          throw new Error(data.error || "Failed to fetch place details");
        }
        const place = (await res.json()) as PlaceLookupResult;
        onPlaceSelect(place);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to load place details"
        );
      } finally {
        setLoadingPlace(false);
      }
    },
    [onPlaceSelect]
  );

  const handleResolveUrl = useCallback(async () => {
    const url = urlValue.trim();
    if (!url) return;

    setResolvingUrl(true);
    setError("");

    try {
      const res = await fetch("/api/venues/google-url-resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) {
        const data = (await res.json()) as {
          error?: string;
          suggestedQuery?: string;
        };
        // 422 = share link couldn't determine exact location, suggest search
        if (res.status === 422 && data.suggestedQuery) {
          setUrlValue("");
          setQuery(data.suggestedQuery);
          inputRef.current?.focus();
          setError(
            "Could not determine exact location from share link. Please select the correct venue from the search results above."
          );
          return;
        }
        throw new Error(data.error || "Failed to resolve URL");
      }
      const place = (await res.json()) as PlaceLookupResult;
      onPlaceSelect(place);
      setUrlValue("");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to resolve Google Maps URL"
      );
    } finally {
      setResolvingUrl(false);
    }
  }, [urlValue, onPlaceSelect]);

  return (
    <div className={cn("space-y-2", className)} ref={containerRef}>
      {/* Search input */}
      <div className="relative">
        <div className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
          {loading || loadingPlace ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Search className="w-4 h-4" />
          )}
        </div>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => {
            if (suggestions.length > 0) setIsOpen(true);
          }}
          placeholder={placeholder}
          disabled={disabled || loadingPlace}
          className={cn(
            "w-full rounded-lg border border-gray-300 pl-9 pr-3 py-2 text-sm text-gray-900 placeholder-gray-400",
            "focus:border-royal focus:outline-none focus:ring-1 focus:ring-royal",
            "disabled:bg-gray-50 disabled:text-gray-500"
          )}
        />
        {query && (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setSuggestions([]);
              setIsOpen(false);
              inputRef.current?.focus();
            }}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
          >
            <X className="w-4 h-4" />
          </button>
        )}

        {/* Dropdown */}
        {isOpen && (
          <div className="absolute z-50 mt-1 w-full bg-white rounded-lg border border-gray-200 shadow-lg max-h-60 overflow-y-auto">
            {suggestions.map((s) => (
              <button
                key={s.placeId}
                type="button"
                onClick={() => selectSuggestion(s)}
                className="w-full text-left px-3 py-2 hover:bg-brand-blue-light flex items-start gap-2 text-sm border-b border-gray-50 last:border-0"
              >
                <MapPin className="w-4 h-4 mt-0.5 text-gray-400 shrink-0" />
                <div className="min-w-0">
                  <div className="font-medium text-gray-900 truncate">
                    {s.mainText}
                  </div>
                  {s.secondaryText && (
                    <div className="text-xs text-gray-500 truncate">
                      {s.secondaryText}
                    </div>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* URL paste input (toggle) */}
      {!showUrl && showUrlInput === undefined && (
        <button
          type="button"
          onClick={() => setShowUrl(true)}
          className="text-xs text-royal hover:text-blue-800 flex items-center gap-1"
        >
          <Link2 className="w-3 h-3" />
          Or paste a Google Maps URL
        </button>
      )}

      {showUrl && (
        <div className="flex gap-2">
          <div className="relative flex-1">
            <div className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
              <Link2 className="w-4 h-4" />
            </div>
            <input
              type="url"
              value={urlValue}
              onChange={(e) => setUrlValue(e.target.value)}
              onPaste={(e) => {
                // Auto-resolve on paste
                const text = e.clipboardData.getData("text");
                if (
                  text.includes("google.com/maps") ||
                  text.includes("maps.app.goo.gl") ||
                  text.includes("goo.gl/maps") ||
                  text.includes("share.google")
                ) {
                  setUrlValue(text);
                  // Trigger resolve after state update
                  setTimeout(() => {
                    const btn = document.getElementById("resolve-url-btn");
                    btn?.click();
                  }, 100);
                }
              }}
              placeholder="Paste Google Maps URL..."
              disabled={disabled || resolvingUrl}
              className={cn(
                "w-full rounded-lg border border-gray-300 pl-9 pr-3 py-2 text-sm text-gray-900 placeholder-gray-400",
                "focus:border-royal focus:outline-none focus:ring-1 focus:ring-royal",
                "disabled:bg-gray-50 disabled:text-gray-500"
              )}
            />
          </div>
          <button
            id="resolve-url-btn"
            type="button"
            onClick={handleResolveUrl}
            disabled={disabled || resolvingUrl || !urlValue.trim()}
            className={cn(
              "px-3 py-2 text-sm font-medium rounded-lg border",
              "bg-white text-gray-700 border-gray-300 hover:bg-gray-50",
              "disabled:opacity-50 disabled:cursor-not-allowed",
              "flex items-center gap-1.5"
            )}
          >
            {resolvingUrl ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              "Resolve"
            )}
          </button>
        </div>
      )}

      {/* Loading indicator when fetching place details */}
      {loadingPlace && (
        <div className="text-sm text-royal flex items-center gap-1.5">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Loading place details...
        </div>
      )}

      {/* Error message */}
      {error && (
        <div className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">
          {error}
        </div>
      )}
    </div>
  );
}
