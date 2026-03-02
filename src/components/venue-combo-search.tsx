"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Search, MapPin, Database, Loader2, X, Plus, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PlaceLookupResult } from "@/lib/google-maps";

interface AutocompleteSuggestion {
  placeId: string;
  mainText: string;
  secondaryText: string;
  fullText: string;
}

interface DbVenue {
  id: string;
  name: string;
  city: string;
  state: string;
  googlePlaceId: string | null;
}

interface VenueComboSearchProps {
  venues: DbVenue[];
  selectedVenueId: string;
  onVenueSelect: (venueId: string) => void;
  disabled?: boolean;
}

export function VenueComboSearch({
  venues,
  selectedVenueId,
  onVenueSelect,
  disabled = false,
}: VenueComboSearchProps) {
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [googleSuggestions, setGoogleSuggestions] = useState<AutocompleteSuggestion[]>([]);
  const [loadingGoogle, setLoadingGoogle] = useState(false);
  const [creatingVenue, setCreatingVenue] = useState(false);
  const [error, setError] = useState("");
  const [pendingPlace, setPendingPlace] = useState<PlaceLookupResult | null>(null);
  const [loadingPlace, setLoadingPlace] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedVenue = venues.find((v) => v.id === selectedVenueId);

  // Filter DB venues client-side
  const filteredDbVenues = query.length >= 1
    ? venues.filter((v) => {
        const q = query.toLowerCase();
        return (
          v.name.toLowerCase().includes(q) ||
          v.city.toLowerCase().includes(q)
        );
      })
    : [];

  // Debounced Google autocomplete
  useEffect(() => {
    if (query.length < 2) {
      setGoogleSuggestions([]);
      return;
    }

    setLoadingGoogle(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/venues/google-autocomplete?q=${encodeURIComponent(query)}`
        );
        if (res.ok) {
          const data = (await res.json()) as { suggestions: AutocompleteSuggestion[] };
          setGoogleSuggestions(data.suggestions);
        }
      } catch {
        // Silently fail
      } finally {
        setLoadingGoogle(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [query]);

  // Click outside to close
  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, []);

  const selectDbVenue = useCallback(
    (venueId: string) => {
      onVenueSelect(venueId);
      setQuery("");
      setIsOpen(false);
      setPendingPlace(null);
    },
    [onVenueSelect]
  );

  const selectGoogleSuggestion = useCallback(
    async (suggestion: AutocompleteSuggestion) => {
      setIsOpen(false);
      setLoadingPlace(true);
      setError("");

      try {
        const res = await fetch(
          `/api/venues/google-place-details?placeId=${encodeURIComponent(suggestion.placeId)}`
        );
        if (!res.ok) {
          throw new Error("Failed to fetch place details");
        }
        const place = (await res.json()) as PlaceLookupResult;

        // Check if this Google Place ID already exists in DB
        const existing = venues.find(
          (v) => v.googlePlaceId && v.googlePlaceId === place.googlePlaceId
        );
        if (existing) {
          // Auto-select the existing venue
          onVenueSelect(existing.id);
          setQuery("");
          setPendingPlace(null);
          return;
        }

        setPendingPlace(place);
        setQuery(place.name || suggestion.mainText);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load place");
      } finally {
        setLoadingPlace(false);
      }
    },
    [venues, onVenueSelect]
  );

  const handleAddVenue = useCallback(async () => {
    if (!pendingPlace) return;
    setCreatingVenue(true);
    setError("");

    try {
      const res = await fetch("/api/venues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: pendingPlace.name,
          address: pendingPlace.address || pendingPlace.formattedAddress || "Unknown",
          city: pendingPlace.city || "Unknown",
          state: pendingPlace.state || "Unknown",
          zip: pendingPlace.zip || "00000",
          latitude: pendingPlace.lat,
          longitude: pendingPlace.lng,
          contactPhone: pendingPlace.phone,
          website: pendingPlace.website,
          description: pendingPlace.description,
          imageUrl: pendingPlace.photoUrl,
          googlePlaceId: pendingPlace.googlePlaceId,
          googleMapsUrl: pendingPlace.googleMapsUrl,
          openingHours: pendingPlace.openingHours,
          googleRating: pendingPlace.googleRating,
          googleRatingCount: pendingPlace.googleRatingCount,
          googleTypes: pendingPlace.googleTypes,
          accessibility: pendingPlace.accessibility,
          parking: pendingPlace.parking,
        }),
      });

      if (res.status === 409) {
        // Duplicate — use existing venue
        const data = (await res.json()) as {
          existingVenue?: { id: string; name: string };
        };
        if (data.existingVenue) {
          onVenueSelect(data.existingVenue.id);
          setPendingPlace(null);
          setQuery("");
          return;
        }
      }

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error || "Failed to create venue");
      }

      const newVenue = (await res.json()) as { id: string; name: string };
      onVenueSelect(newVenue.id);
      setPendingPlace(null);
      setQuery("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add venue");
    } finally {
      setCreatingVenue(false);
    }
  }, [pendingPlace, onVenueSelect]);

  const clearSelection = () => {
    onVenueSelect("");
    setQuery("");
    setPendingPlace(null);
  };

  const showDropdown =
    isOpen && (filteredDbVenues.length > 0 || googleSuggestions.length > 0 || loadingGoogle);

  return (
    <div className="space-y-2" ref={containerRef}>
      <label className="block text-sm font-medium text-gray-700">
        Venue (optional)
      </label>

      {/* Selected venue display */}
      {selectedVenue && !isOpen ? (
        <div className="flex items-center justify-between rounded-lg border border-gray-300 px-3 py-2 bg-gray-50">
          <div className="flex items-center gap-2 text-sm">
            <MapPin className="w-4 h-4 text-gray-400" />
            <span className="font-medium">{selectedVenue.name}</span>
            <span className="text-gray-500">
              — {selectedVenue.city}, {selectedVenue.state}
            </span>
          </div>
          <button
            type="button"
            onClick={clearSelection}
            disabled={disabled}
            className="text-gray-400 hover:text-gray-600"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <div className="relative">
          <div className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
            {loadingPlace ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Search className="w-4 h-4" />
            )}
          </div>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIsOpen(true);
              setPendingPlace(null);
            }}
            onFocus={() => {
              if (query.length >= 1) setIsOpen(true);
            }}
            placeholder="Search existing venues or find on Google..."
            disabled={disabled || loadingPlace}
            className={cn(
              "w-full rounded-lg border border-gray-300 pl-9 pr-9 py-2 text-sm text-gray-900 placeholder-gray-400",
              "focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500",
              "disabled:bg-gray-50 disabled:text-gray-500"
            )}
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setGoogleSuggestions([]);
                setIsOpen(false);
                setPendingPlace(null);
                inputRef.current?.focus();
              }}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              <X className="w-4 h-4" />
            </button>
          )}

          {/* Dropdown */}
          {showDropdown && (
            <div className="absolute z-50 mt-1 w-full bg-white rounded-lg border border-gray-200 shadow-lg max-h-72 overflow-y-auto">
              {/* DB results */}
              {filteredDbVenues.length > 0 && (
                <div>
                  <div className="px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider bg-gray-50 flex items-center gap-1.5">
                    <Database className="w-3 h-3" />
                    Existing Venues
                  </div>
                  {filteredDbVenues.slice(0, 5).map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => selectDbVenue(v.id)}
                      className="w-full text-left px-3 py-2 hover:bg-blue-50 flex items-center gap-2 text-sm border-b border-gray-50"
                    >
                      <MapPin className="w-4 h-4 text-gray-400 shrink-0" />
                      <span className="font-medium">{v.name}</span>
                      <span className="text-gray-500 text-xs">
                        {v.city}, {v.state}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              {/* Google results */}
              {(googleSuggestions.length > 0 || loadingGoogle) && (
                <div>
                  <div className="px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider bg-gray-50 flex items-center gap-1.5">
                    <ExternalLink className="w-3 h-3" />
                    From Google
                    {loadingGoogle && (
                      <Loader2 className="w-3 h-3 animate-spin ml-auto" />
                    )}
                  </div>
                  {googleSuggestions.map((s) => (
                    <button
                      key={s.placeId}
                      type="button"
                      onClick={() => selectGoogleSuggestion(s)}
                      className="w-full text-left px-3 py-2 hover:bg-green-50 flex items-start gap-2 text-sm border-b border-gray-50 last:border-0"
                    >
                      <Plus className="w-4 h-4 mt-0.5 text-green-600 shrink-0" />
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
          )}
        </div>
      )}

      {/* Pending Google venue preview card */}
      {pendingPlace && !selectedVenueId && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-3 space-y-2">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm font-medium text-green-900">
                {pendingPlace.name}
              </p>
              <p className="text-xs text-green-700">
                {pendingPlace.formattedAddress || [pendingPlace.address, pendingPlace.city, pendingPlace.state].filter(Boolean).join(", ")}
              </p>
              {pendingPlace.googleRating != null && (
                <p className="text-xs text-green-600 mt-0.5">
                  Rating: {pendingPlace.googleRating}/5
                  {pendingPlace.googleRatingCount != null &&
                    ` (${pendingPlace.googleRatingCount} reviews)`}
                </p>
              )}
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleAddVenue}
              disabled={creatingVenue}
              className="px-3 py-1.5 text-xs font-medium rounded-md bg-green-700 text-white hover:bg-green-800 disabled:opacity-50 flex items-center gap-1.5"
            >
              {creatingVenue ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Plus className="w-3 h-3" />
              )}
              Add this venue
            </button>
            <button
              type="button"
              onClick={() => {
                setPendingPlace(null);
                setQuery("");
              }}
              className="px-3 py-1.5 text-xs font-medium rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">
          {error}
        </div>
      )}
    </div>
  );
}
