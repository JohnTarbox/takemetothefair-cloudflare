"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Search, Calendar, MapPin, Store, X } from "lucide-react";

interface SearchResults {
  events: { name: string; slug: string; startDate: string | null }[];
  venues: { name: string; slug: string; city: string | null; state: string | null }[];
  vendors: { businessName: string; slug: string; vendorType: string | null }[];
}

export function GlobalSearch() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const search = useCallback(async (q: string) => {
    if (q.length < 2) {
      setResults(null);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const data: SearchResults = await res.json();
      setResults(data);
    } catch {
      setResults(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(query), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, search]);

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
  }, [open]);

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  const navigate = (path: string) => {
    setOpen(false);
    setQuery("");
    setResults(null);
    router.push(path);
  };

  const hasResults = results && (results.events.length > 0 || results.venues.length > 0 || results.vendors.length > 0);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-gray-500 hover:text-gray-700 transition-colors p-1"
        aria-label="Search"
      >
        <Search className="w-5 h-5" />
      </button>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center gap-2 bg-white border border-gray-300 rounded-lg px-3 py-1.5 shadow-sm focus-within:ring-2 focus-within:ring-royal focus-within:border-transparent">
        <Search className="w-4 h-4 text-gray-400 flex-shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && query.trim()) {
              navigate(`/events?query=${encodeURIComponent(query.trim())}`);
            }
          }}
          placeholder="Search events, venues, vendors..."
          className="w-40 md:w-56 text-sm border-none outline-none bg-transparent"
        />
        <button
          onClick={() => { setOpen(false); setQuery(""); setResults(null); }}
          className="text-gray-400 hover:text-gray-600"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Dropdown */}
      {query.length >= 2 && (
        <div className="absolute top-full mt-2 right-0 w-80 bg-white rounded-lg shadow-lg border border-gray-200 z-50 max-h-96 overflow-y-auto">
          {loading && (
            <div className="p-4 text-sm text-gray-500 text-center">Searching...</div>
          )}

          {!loading && !hasResults && (
            <div className="p-4 text-sm text-gray-500 text-center">No results found</div>
          )}

          {!loading && hasResults && (
            <div className="py-2">
              {results!.events.length > 0 && (
                <div>
                  <div className="px-3 py-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wider">Events</div>
                  {results!.events.map((event) => (
                    <button
                      key={event.slug}
                      onClick={() => navigate(`/events/${event.slug}`)}
                      className="w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center gap-3 transition-colors"
                    >
                      <Calendar className="w-4 h-4 text-amber flex-shrink-0" />
                      <span className="text-sm text-gray-900 truncate">{event.name}</span>
                    </button>
                  ))}
                </div>
              )}

              {results!.venues.length > 0 && (
                <div>
                  <div className="px-3 py-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wider border-t border-gray-100 mt-1">Venues</div>
                  {results!.venues.map((venue) => (
                    <button
                      key={venue.slug}
                      onClick={() => navigate(`/venues/${venue.slug}`)}
                      className="w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center gap-3 transition-colors"
                    >
                      <MapPin className="w-4 h-4 text-royal flex-shrink-0" />
                      <div className="min-w-0">
                        <div className="text-sm text-gray-900 truncate">{venue.name}</div>
                        {(venue.city || venue.state) && (
                          <div className="text-xs text-gray-500">{[venue.city, venue.state].filter(Boolean).join(", ")}</div>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {results!.vendors.length > 0 && (
                <div>
                  <div className="px-3 py-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wider border-t border-gray-100 mt-1">Vendors</div>
                  {results!.vendors.map((vendor) => (
                    <button
                      key={vendor.slug}
                      onClick={() => navigate(`/vendors/${vendor.slug}`)}
                      className="w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center gap-3 transition-colors"
                    >
                      <Store className="w-4 h-4 text-green-600 flex-shrink-0" />
                      <div className="min-w-0">
                        <div className="text-sm text-gray-900 truncate">{vendor.businessName}</div>
                        {vendor.vendorType && (
                          <div className="text-xs text-gray-500">{vendor.vendorType}</div>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}

              <button
                onClick={() => navigate(`/events?query=${encodeURIComponent(query.trim())}`)}
                className="w-full text-center px-3 py-2.5 text-sm text-royal hover:bg-gray-50 border-t border-gray-100 font-medium transition-colors"
              >
                View all results →
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
