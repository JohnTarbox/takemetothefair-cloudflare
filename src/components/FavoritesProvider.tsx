"use client";

/**
 * Per-page favorites cache to eliminate the N+1 fetch pattern.
 *
 * Cohort 4 (analyst, 2026-06-01). Before: every FavoriteButton mount
 * fired GET /api/favorites?type=X, so `/vendors` (50 cards) cost 50
 * round-trips — DOMContentLoaded ~4.3s. The API already supports the
 * `?type=` filter that returns all favorites of a type for the
 * logged-in user, so 49 of those fetches were duplicates.
 *
 * Shape:
 *   - One fetch per (type) per page-load (lazy, on first child mount).
 *   - In-memory Map<type, Set<id>> shared via context.
 *   - Optimistic add/remove keep cards in sync without round-tripping
 *     the GET on every toggle. The button still POSTs/DELETEs to the
 *     API; the Set update wraps that call.
 *   - In-flight fetches deduplicated via a per-type Promise cache so
 *     two cards mounting at the exact same tick share one request.
 *
 * Out of scope for this PR: server-side `is_favorite` on the list
 * payload (events/vendors/venues endpoints). That would drop even the
 * single fetch, but the surface is larger and the win here is already
 * 50x → 1.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSession } from "next-auth/react";

type FavoritableType = "EVENT" | "VENUE" | "VENDOR" | "PROMOTER";

interface FavoritesContextValue {
  isFavorited: (type: FavoritableType, id: string) => boolean;
  setFavorited: (type: FavoritableType, id: string, favorited: boolean) => void;
  /** True while the first fetch for `type` is in flight. */
  isLoadingType: (type: FavoritableType) => boolean;
  /** True only when no session — cards render as inert. */
  isAnonymous: boolean;
}

const FavoritesContext = createContext<FavoritesContextValue | null>(null);

interface FavoritesPayload {
  favorites: Array<{ id: string; favoritableType: string; favoritableId: string }>;
}

export function FavoritesProvider({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  const userId = session?.user?.id ?? null;
  const isAnonymous = status !== "loading" && !userId;

  // Storage: Map<type, Set<favoritableId>> — outer Map is stable
  // across re-renders (no setState on entries), inner Set replaced on
  // toggle so React can detect the change via the `version` counter.
  const cacheRef = useRef(new Map<FavoritableType, Set<string>>());
  // In-flight promises so two cards mounting in the same tick share
  // one network request. Cleared once the promise resolves.
  const inflightRef = useRef(new Map<FavoritableType, Promise<void>>());
  const [version, setVersion] = useState(0);
  const [loadingTypes, setLoadingTypes] = useState<Set<FavoritableType>>(new Set());

  // Clear cache when the session changes (login / logout). Without
  // this a logged-in cache would leak into an anonymous view after
  // logout, showing hearts filled for items the new viewer didn't fav.
  useEffect(() => {
    cacheRef.current = new Map();
    inflightRef.current = new Map();
    setLoadingTypes(new Set());
    setVersion((v) => v + 1);
  }, [userId]);

  const ensureFetched = useCallback(
    async (type: FavoritableType): Promise<void> => {
      if (!userId) return; // anonymous — nothing to fetch
      if (cacheRef.current.has(type)) return; // already populated
      const existing = inflightRef.current.get(type);
      if (existing) {
        await existing;
        return;
      }
      // Start a new fetch and stash the promise so concurrent callers
      // wait on it instead of firing duplicate requests.
      const promise = (async () => {
        setLoadingTypes((prev) => {
          if (prev.has(type)) return prev;
          const next = new Set(prev);
          next.add(type);
          return next;
        });
        try {
          const res = await fetch(`/api/favorites?type=${type}`);
          if (!res.ok) {
            // Initialize empty so we don't retry on every button. A
            // 401 from auth-drift means anonymous; treat as no favorites.
            cacheRef.current.set(type, new Set());
            return;
          }
          const data = (await res.json()) as FavoritesPayload;
          const ids = new Set(data.favorites.map((f) => f.favoritableId));
          cacheRef.current.set(type, ids);
        } catch {
          // Network error — same as 401, empty set so cards just
          // render unfavorited. Console-noisy errors are not useful here.
          cacheRef.current.set(type, new Set());
        } finally {
          inflightRef.current.delete(type);
          setLoadingTypes((prev) => {
            if (!prev.has(type)) return prev;
            const next = new Set(prev);
            next.delete(type);
            return next;
          });
          setVersion((v) => v + 1);
        }
      })();
      inflightRef.current.set(type, promise);
      await promise;
    },
    [userId]
  );

  const isFavorited = useCallback(
    (type: FavoritableType, id: string): boolean => {
      // Lazily kick off the fetch on first read. Don't await — the
      // initial render returns false (= unfavorited heart) and the
      // re-render after the fetch flips the state. Mirrors the
      // previous per-button useEffect timing.
      if (!cacheRef.current.has(type) && userId) {
        void ensureFetched(type);
      }
      return cacheRef.current.get(type)?.has(id) ?? false;
    },
    [ensureFetched, userId]
  );

  const setFavorited = useCallback((type: FavoritableType, id: string, favorited: boolean) => {
    const current = cacheRef.current.get(type) ?? new Set<string>();
    const next = new Set(current);
    if (favorited) next.add(id);
    else next.delete(id);
    cacheRef.current.set(type, next);
    setVersion((v) => v + 1);
  }, []);

  const isLoadingType = useCallback(
    (type: FavoritableType) => loadingTypes.has(type),
    [loadingTypes]
  );

  // The `version` counter is consumed via useMemo's dependency list so
  // consumers re-render when the cache mutates. Without it, the
  // useCallback identities are stable and React wouldn't redraw cards.
  const value = useMemo<FavoritesContextValue>(
    () => ({ isFavorited, setFavorited, isLoadingType, isAnonymous }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isFavorited, setFavorited, isLoadingType, isAnonymous, version]
  );

  return <FavoritesContext.Provider value={value}>{children}</FavoritesContext.Provider>;
}

/**
 * Read-only hook used by FavoriteButton. Returns sensible defaults
 * when called outside the provider (no crash, just no caching).
 */
export function useFavorites(): FavoritesContextValue {
  const ctx = useContext(FavoritesContext);
  if (ctx) return ctx;
  // Fallback so a FavoriteButton rendered outside the provider still
  // works — no batching, but no crash either. Render-only false +
  // no-op setter; isLoadingType false; treat as logged-out so the
  // button at least responds to clicks via its own session check.
  return {
    isFavorited: () => false,
    setFavorited: () => {},
    isLoadingType: () => false,
    isAnonymous: true,
  };
}
