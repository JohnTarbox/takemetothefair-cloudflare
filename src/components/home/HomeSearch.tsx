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

// Functional category quick-filters → /events?category=. (Date "when" chips
// are deferred to C2 P2, which adds a date filter on /events.)
const QUICK_CATEGORIES: ReadonlyArray<{ label: string; value: string }> = [
  { label: "Agricultural fairs", value: "Agricultural Fair" },
  { label: "Craft fairs", value: "Craft Fair" },
  { label: "Farmers markets", value: "Farmers Market" },
];

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
    <div className="mt-5 max-w-[660px] text-left">
      {/* "Printed" search bar — navy keyline + hard offset shadow, amber action. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          navigate();
        }}
        className="flex flex-col items-stretch overflow-hidden rounded-[14px] border-[1.5px] border-secondary bg-card shadow-[6px_6px_0_rgb(var(--secondary)/0.12)] sm:flex-row"
        role="search"
        aria-label="Search events"
      >
        <div className="flex flex-1 items-center gap-2.5 px-4">
          <Search className="h-5 w-5 flex-none text-muted-foreground" aria-hidden="true" />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search fairs, festivals, vendors…"
            aria-label="Keyword"
            className="h-[52px] border-0 bg-transparent px-0 text-base text-foreground shadow-none focus-visible:ring-0"
          />
        </div>

        <div className="flex items-center border-t border-border px-3 sm:border-l sm:border-t-0">
          <MapPin className="mr-1.5 h-5 w-5 flex-none text-muted-foreground" aria-hidden="true" />
          <select
            value={stateCode}
            onChange={(e) => setStateCode(e.target.value)}
            aria-label="State"
            className="h-12 w-full cursor-pointer bg-transparent pr-2 text-[15px] font-medium text-secondary focus:outline-none sm:h-[52px] sm:w-auto"
          >
            {NE_STATES.map((s) => (
              <option key={s.code || "all"} value={s.code}>
                {s.label}
              </option>
            ))}
          </select>
        </div>

        <button
          type="submit"
          /* HP-DARK1 (2026-06-21): text-primary-foreground (amber-ink 31 26 10,
             fixed in both themes) instead of text-navy-dark, which lifts to a
             light sky-blue in dark mode → 1.37:1 on the unchanged amber fill.
             Matches the sibling "I'm a Promoter" amber CTA button. */
          className="flex items-center justify-center gap-2 bg-amber px-7 py-4 text-base font-bold text-primary-foreground transition-colors hover:bg-amber/90 sm:py-0"
        >
          <Search className="h-[18px] w-[18px]" aria-hidden="true" />
          Search
        </button>
      </form>

      {/* Functional quick-filters (ticket-stub chips). */}
      <div className="mt-3 flex flex-wrap items-center gap-2.5">
        <button
          type="button"
          onClick={() => navigate({ sort: "nearest" })}
          className="inline-flex items-center gap-1.5 rounded-full border border-amber/40 bg-amber-light px-3.5 py-[7px] text-[13.5px] font-semibold text-secondary hover:bg-amber-light/70"
        >
          <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
          Events near me
        </button>
        <button
          type="button"
          onClick={() => navigate({ when: "weekend" })}
          className="inline-flex items-center rounded-full border border-amber/40 bg-amber-light px-3.5 py-[7px] text-[13.5px] font-semibold text-secondary hover:bg-amber-light/70"
        >
          This weekend
        </button>
        <button
          type="button"
          onClick={() => navigate({ when: "month" })}
          className="inline-flex items-center rounded-full border border-amber/40 bg-amber-light px-3.5 py-[7px] text-[13.5px] font-semibold text-secondary hover:bg-amber-light/70"
        >
          This month
        </button>
        {QUICK_CATEGORIES.map((c) => (
          <Link
            key={c.value}
            href={`/events?category=${encodeURIComponent(c.value)}`}
            className="inline-flex items-center rounded-full border border-amber/40 bg-amber-light px-3.5 py-[7px] text-[13.5px] font-semibold text-secondary hover:bg-amber-light/70"
          >
            {c.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
