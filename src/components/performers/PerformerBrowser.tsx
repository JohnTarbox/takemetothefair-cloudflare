"use client";

/**
 * OPE-122 — client-side browse/search over the public performer list. The full
 * public set is server-rendered (small catalog, like the /promoters index); this
 * adds instant name search + act-category filter chips without a round-trip.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { Music, MapPin, ShieldCheck, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  filterPerformers,
  PERFORMER_CATEGORY_LABEL,
  type PublicPerformer,
} from "@/lib/performers/list-public";

export function PerformerBrowser({ performers }: { performers: PublicPerformer[] }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);

  // Categories actually present in the catalog, in label order.
  const categories = useMemo(() => {
    const present = new Set(performers.map((p) => p.actCategory).filter(Boolean) as string[]);
    return [...present].sort((a, b) =>
      (PERFORMER_CATEGORY_LABEL[a] ?? a).localeCompare(PERFORMER_CATEGORY_LABEL[b] ?? b)
    );
  }, [performers]);

  const filtered = useMemo(
    () => filterPerformers(performers, query, category),
    [performers, query, category]
  );

  return (
    <div>
      <div className="mb-6 space-y-4">
        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search performers by name…"
            aria-label="Search performers by name"
            className="w-full rounded-md border border-border bg-card pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy"
          />
        </div>

        {categories.length > 0 && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setCategory(null)}
              className={`rounded-full border px-3 py-1 text-sm transition ${
                category === null
                  ? "border-navy bg-navy text-white"
                  : "border-border bg-card text-muted-foreground hover:border-navy"
              }`}
            >
              All
            </button>
            {categories.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCategory(c)}
                className={`rounded-full border px-3 py-1 text-sm transition ${
                  category === c
                    ? "border-navy bg-navy text-white"
                    : "border-border bg-card text-muted-foreground hover:border-navy"
                }`}
              >
                {PERFORMER_CATEGORY_LABEL[c] ?? c}
              </button>
            ))}
          </div>
        )}
      </div>

      <p className="text-sm text-muted-foreground mb-4" aria-live="polite">
        {filtered.length} {filtered.length === 1 ? "performer" : "performers"}
      </p>

      {filtered.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No performers match your search.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((p) => {
            const homeBase = [p.homeBaseCity, p.homeBaseState].filter(Boolean).join(", ");
            const label = p.actCategory ? PERFORMER_CATEGORY_LABEL[p.actCategory] : null;
            return (
              <Link
                key={p.id}
                href={`/performers/${p.slug}`}
                className="block rounded-lg border border-border bg-card p-4 hover:shadow-sm transition"
              >
                <div className="flex items-start gap-3">
                  {p.imageUrl ? (
                    <div className="w-12 h-12 rounded-full overflow-hidden bg-muted border border-border relative shrink-0">
                      <Image
                        src={p.imageUrl}
                        alt={p.name}
                        fill
                        sizes="48px"
                        className="object-cover"
                      />
                    </div>
                  ) : (
                    <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center shrink-0">
                      <Music className="w-5 h-5 text-muted-foreground" />
                    </div>
                  )}
                  <div className="min-w-0">
                    <p className="font-semibold text-foreground flex items-center gap-1 flex-wrap">
                      <span className="truncate">{p.name}</span>
                      {p.verified && (
                        <Badge variant="info" className="text-xs">
                          <ShieldCheck className="w-3 h-3 mr-1 inline" />
                          Verified
                        </Badge>
                      )}
                    </p>
                    <p className="text-sm text-muted-foreground flex items-center gap-2 flex-wrap">
                      {label && <span>{label}</span>}
                      {homeBase && (
                        <span className="flex items-center gap-1">
                          <MapPin className="w-3 h-3" />
                          {homeBase}
                        </span>
                      )}
                    </p>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
