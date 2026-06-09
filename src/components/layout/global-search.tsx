"use client";

import { useState, useEffect, useRef, useCallback, memo } from "react";
import { useRouter } from "next/navigation";
import { Search, Calendar, MapPin, Store, FileText, X } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { trackEvent, trackSearchResults, trackZeroResults } from "@/lib/analytics";
import { displayVenueName } from "@/lib/venue-display";

interface SearchResults {
  events: { name: string; slug: string; startDate: string | null }[];
  venues: { name: string; slug: string; city: string | null; state: string | null }[];
  vendors: {
    businessName: string;
    displayName?: string | null;
    slug: string;
    vendorType: string | null;
  }[];
  blogPosts: { title: string; slug: string; excerpt: string | null }[];
}

/** Fires a zero-results analytics event once when mounted */
const ZeroResultsTracker = memo(function ZeroResultsTracker({ query }: { query: string }) {
  useEffect(() => {
    trackZeroResults(query);
  }, [query]);
  return null;
});

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
      const total =
        data.events.length + data.venues.length + data.vendors.length + data.blogPosts.length;
      trackSearchResults(q, total);
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

  const hasResults =
    results &&
    (results.events.length > 0 ||
      results.venues.length > 0 ||
      results.vendors.length > 0 ||
      results.blogPosts.length > 0);

  if (!open) {
    // U7 (2026-06-07) — migrated trigger to IconButton. Primitive enforces
    // a 40×40 min hit area at size="md" (up from the prior ~28×28 of
    // icon + p-1 padding), satisfying WCAG 2.2 AA 2.5.8 on dense headers.
    return (
      <IconButton
        size="md"
        onClick={() => setOpen(true)}
        icon={<Search className="w-5 h-5" />}
        aria-label="Search"
      />
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center gap-2 bg-card border border-border rounded-lg px-3 py-1.5 shadow-sm focus-within:ring-2 focus-within:ring-royal focus-within:border-transparent">
        <Search className="w-4 h-4 text-muted-foreground flex-shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && query.trim()) {
              trackEvent("search", { category: "engagement", label: query.trim() });
              navigate(`/search?q=${encodeURIComponent(query.trim())}`);
            }
          }}
          placeholder="Search events, venues, vendors, blog..."
          // SEARCH1 (2026-06-09) — Mirror the server-side 100-char cap
          // (src/app/api/search/route.ts MAX_QUERY_LENGTH). Belt-and-
          // suspenders: server is authoritative; this just prevents
          // a user from pasting a 10kb chunk that the server will
          // then drop on the floor anyway.
          maxLength={100}
          className="w-40 md:w-56 text-sm border-none outline-none bg-transparent"
        />
        {/* U7 (2026-06-07) — pre-migration this <button> rendered an
            icon-only X with NO aria-label (WCAG 4.1.2 violation) and no
            explicit hit area. IconButton's required-aria-label prop catches
            the missing-name shape at compile time; size="sm" enforces the
            32×32 hit-area floor. */}
        <IconButton
          size="sm"
          onClick={() => {
            setOpen(false);
            setQuery("");
            setResults(null);
          }}
          icon={<X className="w-4 h-4" />}
          aria-label="Close search"
        />
      </div>

      {/* Dropdown */}
      {query.length >= 2 && (
        <div className="absolute top-full mt-2 right-0 w-80 bg-card rounded-lg shadow-lg border border-border z-50 max-h-96 overflow-y-auto">
          {loading && (
            <div className="p-4 text-sm text-muted-foreground text-center">Searching...</div>
          )}

          {!loading && !hasResults && results && (
            <div className="p-4 text-sm text-muted-foreground text-center">
              {/* Track zero-result searches to identify content gaps */}
              <ZeroResultsTracker query={query} />
              No results found
            </div>
          )}

          {!loading && hasResults && (
            <div className="py-2">
              {results!.events.length > 0 && (
                <div>
                  <div className="px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Events
                  </div>
                  {results!.events.map((event) => (
                    <button
                      key={event.slug}
                      onClick={() => navigate(`/events/${event.slug}`)}
                      className="w-full text-left px-3 py-2 hover:bg-muted flex items-center gap-3 transition-colors"
                    >
                      <Calendar className="w-4 h-4 text-amber-fg flex-shrink-0" />
                      <span className="text-sm text-foreground truncate">{event.name}</span>
                    </button>
                  ))}
                </div>
              )}

              {results!.venues.length > 0 && (
                <div>
                  <div className="px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider border-t border-border mt-1">
                    Venues
                  </div>
                  {results!.venues.map((venue) => (
                    <button
                      key={venue.slug}
                      onClick={() => navigate(`/venues/${venue.slug}`)}
                      className="w-full text-left px-3 py-2 hover:bg-muted flex items-center gap-3 transition-colors"
                    >
                      <MapPin className="w-4 h-4 text-royal flex-shrink-0" />
                      <div className="min-w-0">
                        <div className="text-sm text-foreground truncate">
                          {displayVenueName(venue)}
                        </div>
                        {(venue.city || venue.state) && (
                          <div className="text-xs text-muted-foreground">
                            {[venue.city, venue.state].filter(Boolean).join(", ")}
                          </div>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {results!.vendors.length > 0 && (
                <div>
                  <div className="px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider border-t border-border mt-1">
                    Vendors
                  </div>
                  {results!.vendors.map((vendor) => (
                    <button
                      key={vendor.slug}
                      onClick={() => navigate(`/vendors/${vendor.slug}`)}
                      className="w-full text-left px-3 py-2 hover:bg-muted flex items-center gap-3 transition-colors"
                    >
                      <Store className="w-4 h-4 text-green-600 flex-shrink-0" />
                      <div className="min-w-0">
                        <div className="text-sm text-foreground truncate">
                          {/* EH2.1 — honor brand display_name override (e.g.
                              "LeafFilter" instead of "LeafFilter North LLC").
                              Full brand_parent-mode collapse (one search row
                              per brand) lands with PR EH2.4's search dedup. */}
                          {vendor.displayName ?? vendor.businessName}
                        </div>
                        {vendor.vendorType && (
                          <div className="text-xs text-muted-foreground">{vendor.vendorType}</div>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {results!.blogPosts.length > 0 && (
                <div>
                  <div className="px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider border-t border-border mt-1">
                    Blog
                  </div>
                  {results!.blogPosts.map((post) => (
                    <button
                      key={post.slug}
                      onClick={() => navigate(`/blog/${post.slug}`)}
                      className="w-full text-left px-3 py-2 hover:bg-muted flex items-center gap-3 transition-colors"
                    >
                      <FileText className="w-4 h-4 text-purple-600 flex-shrink-0" />
                      <span className="text-sm text-foreground truncate">{post.title}</span>
                    </button>
                  ))}
                </div>
              )}

              <button
                onClick={() => {
                  trackEvent("search", { category: "engagement", label: query.trim() });
                  navigate(`/search?q=${encodeURIComponent(query.trim())}`);
                }}
                className="w-full text-center px-3 py-2.5 text-sm text-royal hover:bg-muted border-t border-border font-medium transition-colors"
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
