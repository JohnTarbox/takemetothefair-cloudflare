"use client";

/**
 * OPE-1691 — one "now" for server render and hydration.
 *
 * Listing cards print day-granular, clock-dependent text: "Today", "Tomorrow",
 * "This weekend", "Next: <date>", "Now through <date>", "Ended". The listing
 * HTML is cached (ISR `revalidate` plus the CDN's max-age / stale-while-
 * revalidate), so a page can hydrate hours — on a rarely-visited facet page,
 * days — after the server rendered it. When a UTC day boundary falls between
 * the two, the client's first render printed different text than the server
 * did and React threw #418 (OPE-482's regression on the listing path).
 *
 * The root layout passes its own render time in. Hydration reads that value,
 * so the client's first render reproduces the server HTML exactly. After
 * mount the provider switches to the live clock: an ordinary re-render, not a
 * hydration, so the labels become current without a mismatch.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

const RenderNowContext = createContext<number | null>(null);

export function RenderNowProvider({ now, children }: { now: number; children: ReactNode }) {
  const [value, setValue] = useState(now);
  useEffect(() => {
    setValue(Date.now());
  }, []);
  return <RenderNowContext.Provider value={value}>{children}</RenderNowContext.Provider>;
}

/**
 * The "now" to compute display text from. Inside RenderNowProvider this is the
 * server's render time during hydration and the live clock afterwards. Outside
 * it (tests, isolated renders) it falls back to the clock at first render.
 */
export function useRenderNow(): Date {
  const ms = useContext(RenderNowContext);
  const [fallback] = useState(() => Date.now());
  return useMemo(() => new Date(ms ?? fallback), [ms, fallback]);
}
