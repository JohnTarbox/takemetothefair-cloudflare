/**
 * OPE-392 Ask C — which sinks each tracked event goes to, declared rather
 * than implied.
 *
 * ── The ticket's stated root cause is not what the code shows ─────────────
 *
 * The ticket says the drift came from "two independent write paths (`gtag`
 * calls in components + a separate first-party beacon)". Read from source
 * 2026-08-30, that is not the shape. Both sinks already live in ONE module,
 * `src/lib/analytics.ts`, and the only `gtag(` call sites outside it are
 * `WebVitals.tsx` (GA4-only by design — ADR-001 keeps Web Vitals on GA4) and
 * the bootstrap in `layout.tsx`. There are no rogue component call sites.
 *
 * The real defect is subtler and more interesting: **each wrapper decides for
 * itself whether to call the beacon, and "no beacon" is expressed by
 * ABSENCE.** An omission and a deliberate choice look identical in the source.
 *
 * Both exist today:
 *
 *   trackShare            no beacon, with a comment explaining why — a
 *                         DECISION ("share volume is low… revisit once
 *                         share_method propagates")
 *   trackAddToCalendar    no beacon, no comment — an OVERSIGHT
 *
 * You cannot tell them apart without reading every function and guessing at
 * intent. That is what this file fixes: a sink set is now stated, and a
 * single-sink event must say WHY in `singleSinkReason` or the test fails.
 * Forgetting becomes impossible; deciding stays possible and is recorded.
 *
 * ── The re-verify the ticket asked for, answered ──────────────────────────
 *
 * "Confirm whether the seven new register/submit/claim events already
 * dual-emit before starting Ask C — if they were added via gtag alone, the
 * drift is actively recurring."
 *
 * They were not. `trackFunnelView` / `trackFunnelInteracted` /
 * `trackFunnelSubmitted` are **beacon-only and documented as such** ("routing
 * them through GA4 as well would add a custom-dimension registration
 * dependency for no extra answer"). So the drift is historical, not live, and
 * Ask C's priority is prevention rather than a fire. It is still worth doing —
 * the two events below prove the failure mode is real — but it is not urgent.
 *
 * ── Why this file, and not a comment convention ───────────────────────────
 *
 * `BEACON_EVENT_NAMES` is spread into the allowlist in
 * `/api/analytics/track/route.ts`, exactly as `NEW_FUNNEL_STEP_NAMES` already
 * is. A beacon event that is not allowlisted is rejected 400 by the server and
 * silently vanishes — deriving the allowlist from the registry means the write
 * path and the accept path cannot drift apart.
 */

/**
 * Entities an intent event can be about.
 *
 * PROMOTER is included because promoter pages carry an official-site link;
 * it has no favourite or calendar affordance, which is why the favourites
 * type union (`FavoritableType`) and this one are not the same list.
 */
export type TrackedEntityType = "EVENT" | "VENUE" | "VENDOR" | "PROMOTER";

/** The two places an event can land. */
export type AnalyticsSink = "ga4" | "beacon";

/** Beacon categories accepted by /api/analytics/track. */
export type AnalyticsCategory = "funnel" | "engagement" | "conversion";

export interface TrackedEventDef {
  name: string;
  category: AnalyticsCategory;
  /** Non-empty. An event that goes nowhere is not an event. */
  sinks: readonly AnalyticsSink[];
  /**
   * REQUIRED when `sinks` is not both. Says why, so a later reader can tell a
   * decision from an omission — the whole point of this file. Enforced by
   * test, not by convention.
   */
  singleSinkReason?: string;
}

const BOTH: readonly AnalyticsSink[] = ["ga4", "beacon"];

/**
 * The events OPE-392 owns. Deliberately NOT the full historical catalogue —
 * retro-fitting every legacy event would be a large, risky sweep with no
 * behaviour change, and this registry is useful the moment new events use it.
 * Legacy wrappers keep working unchanged; they are simply not yet declared.
 */
export const TRACKED_EVENTS: readonly TrackedEventDef[] = [
  // ── Ask A — intent events promoted to first-party ───────────────────────
  //
  // All three were GA4-only. GA4's ~90 days cannot be backfilled into D1 (the
  // beacon is forward-only), so these series start at ship date.
  {
    name: "add_to_calendar",
    category: "conversion",
    sinks: BOTH,
  },
  {
    name: "add_to_favorites",
    category: "engagement",
    sinks: BOTH,
  },
  {
    name: "remove_from_favorites",
    category: "engagement",
    sinks: BOTH,
  },
  {
    // Reverses the documented "no beacon mirror" decision in trackShare.
    // That call was made pending `share_method` propagating as a GA4 custom
    // dimension; OPE-391's Block D2 now needs share in the durable store to
    // sit in the attendance-intent strip beside calendar and favourites, and
    // a strip missing one of its four members is worse than the storage cost
    // of ~72 events/90d.
    name: "share",
    category: "engagement",
    sinks: BOTH,
  },

  // ── Ask B — the three genuinely uninstrumented interactions ─────────────
  {
    name: "directions_click",
    category: "engagement",
    sinks: BOTH,
  },
  {
    // Distinct from the generic `click_external_link` that TrackedLink emits,
    // which is GA4-only and uncategorised — the ticket's suspicion that
    // website clicks are "lumped into GA4's generic click" is correct.
    name: "outbound_website_click",
    category: "conversion",
    sinks: BOTH,
  },
  {
    name: "contact_click",
    category: "conversion",
    sinks: BOTH,
  },
];

/** Names that must appear in the /api/analytics/track allowlist. */
export const BEACON_EVENT_NAMES = TRACKED_EVENTS.filter((e) => e.sinks.includes("beacon")).map(
  (e) => e.name
);

/** Lookup used by `track()`; undefined for a legacy, undeclared event. */
export function findTrackedEvent(name: string): TrackedEventDef | undefined {
  return TRACKED_EVENTS.find((e) => e.name === name);
}
