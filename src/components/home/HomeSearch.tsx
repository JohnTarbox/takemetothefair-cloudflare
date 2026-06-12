"use client";

/**
 * C2 P1 (2026-06-12) — above-the-fold homepage search.
 *
 * The directory's core job-to-be-done is "find an event near me, soon." This
 * is the hero's primary action. It composes existing /events filters — it does
 * NOT introduce new query semantics:
 *   - keyword  → /events?query=
 *   - state    → /events?state=<2-letter stateCode>
 *   - Near me  → /events?sort=nearest  (events-view already prompts for browser
 *                geolocation and computes distance via src/lib/geo.ts)
 *
 * Submitting always navigates to /events with the selected params (C2 decision
 * #4) — the homepage weekend peek is the preview; this is the tool that lands
 * the visitor in results. The "When" date chips are deferred to C2 P2 (a date
 * filter on /events doesn't exist yet).
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Search, MapPin } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

// New England + the 2-letter stateCode /events filters on (events.state_code).
const NE_STATES: ReadonlyArray<{ code: string; label: string }> = [
  { code: "", label: "All of New England" },
  { code: "ME", label: "Maine" },
  { code: "NH", label: "New Hampshire" },
  { code: "VT", label: "Vermont" },
  { code: "MA", label: "Massachusetts" },
  { code: "CT", label: "Connecticut" },
  { code: "RI", label: "Rhode Island" },
];

export function HomeSearch() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [stateCode, setStateCode] = useState("");

  function navigate(extra?: Record<string, string>) {
    const params = new URLSearchParams();
    const q = query.trim();
    if (q) params.set("query", q);
    if (stateCode) params.set("state", stateCode);
    if (extra) for (const [k, v] of Object.entries(extra)) params.set(k, v);
    const qs = params.toString();
    router.push(qs ? `/events?${qs}` : "/events");
  }

  return (
    <div className="mx-auto mt-8 max-w-2xl text-left">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          navigate();
        }}
        className="flex flex-col gap-2 rounded-xl bg-card p-2 shadow-lg sm:flex-row sm:items-stretch"
        role="search"
        aria-label="Search events"
      >
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search fairs, festivals, vendors…"
            aria-label="Keyword"
            className="h-12 border-0 bg-transparent pl-10 text-base text-foreground shadow-none focus-visible:ring-0"
          />
        </div>

        <div className="flex items-center sm:border-l sm:border-border sm:pl-2">
          <MapPin className="mr-1 h-5 w-5 text-muted-foreground sm:ml-1" aria-hidden="true" />
          <select
            value={stateCode}
            onChange={(e) => setStateCode(e.target.value)}
            aria-label="State"
            className="h-12 w-full rounded-md bg-transparent px-2 text-base text-foreground focus:outline-none sm:w-auto"
          >
            {NE_STATES.map((s) => (
              <option key={s.code || "all"} value={s.code}>
                {s.label}
              </option>
            ))}
          </select>
        </div>

        <Button
          type="submit"
          size="lg"
          className="h-12 bg-amber font-semibold text-primary-foreground hover:bg-amber/90"
        >
          <Search className="mr-2 h-5 w-5" aria-hidden="true" />
          Search
        </Button>
      </form>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 pl-1 text-sm text-secondary-foreground/80">
        <button
          type="button"
          onClick={() => navigate({ sort: "nearest" })}
          className="inline-flex items-center gap-1 font-medium underline-offset-2 hover:underline"
        >
          <MapPin className="h-4 w-4" aria-hidden="true" />
          Events near me
        </button>
        <span aria-hidden="true">·</span>
        <Link href="/events" className="underline-offset-2 hover:underline">
          Browse all events
        </Link>
      </div>
    </div>
  );
}
