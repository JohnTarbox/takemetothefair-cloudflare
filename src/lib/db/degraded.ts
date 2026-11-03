/**
 * OPE-790 rework (John, 2026-10-04: "yes to an honest degraded panel when a D1
 * fault survives the retry").
 *
 * A Cloudflare-side D1 blip that survives `withD1Read`'s one retry used to reach
 * the error boundary — "Something went wrong" — for a fault that clears in
 * seconds and is not ours. The page now renders its chrome plus a panel that
 * SAYS it is degraded. That keeps REL1's actual invariant ("visibly distinct
 * from a real empty state"): it never pretends to be an empty result.
 *
 * Only a PLATFORM fault degrades. A query defect still throws to the error
 * boundary, because that is our bug and must stay loud.
 *
 * Search engines: the degraded render carries `noindex`, so a crawler that hits
 * the few seconds of a blip cannot index "trouble loading" as the page. (These
 * routes render per request — measured 10-04: 2 requests = 2 renders — so a
 * degraded render is never cached and served to anyone else.)
 */
import type { Metadata } from "next";
import { classifyD1Error } from "./d1-resilience";

/** True when this error (or anything in its `cause` chain) is a D1 platform blip. */
export function isD1PlatformFault(e: unknown): boolean {
  return classifyD1Error(e) === "platform_transient";
}

export const DEGRADED_METADATA: Metadata = {
  title: "Temporarily unavailable | Meet Me at the Fair",
  robots: { index: false, follow: false },
};
