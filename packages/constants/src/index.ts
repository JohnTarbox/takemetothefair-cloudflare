/**
 * Shared status enums + types used by both the main app and the MCP server.
 *
 * Schema-relevant constants live here (the values appear in Drizzle column
 * definitions and Zod enum validators); UI-only constants like pagination
 * limits stay in src/lib/constants.ts in the main app.
 */

// ── Site identity ─────────────────────────────────────────────────
// Single source of truth for the canonical site URL, hostname, and the
// support/from email address. Use SITE_URL when constructing absolute
// links, SITE_HOSTNAME for cases like iCal UIDs that need a bare host,
// SUPPORT_EMAIL for the noreply From address, and SCRAPER_USER_AGENT
// for outbound HTTP requests so polite-bot identification stays
// consistent across every scraper.

export const SITE_URL = "https://meetmeatthefair.com";
export const SITE_HOSTNAME = "meetmeatthefair.com";
export const SUPPORT_EMAIL = "noreply@meetmeatthefair.com";
export const SCRAPER_USER_AGENT =
  "Mozilla/5.0 (compatible; MeetMeAtTheFair/1.0; +https://meetmeatthefair.com)";

// ── Workers AI model ──────────────────────────────────────────────
// Single source of truth for the Cloudflare Workers AI text-generation
// model used by both deploy artifacts: URL/email extraction in the main
// app (src/lib/url-import/ai-extractor.ts) and the inbound-email intent
// classifier in the MCP worker (mcp-server/src/intent-classifier.ts).
//
// History:
//   @cf/meta/llama-3.1-8b-instruct (through 2026-06-15) — DEPRECATED by
//     Cloudflare; began returning error 5028 on every call, which hard-
//     failed the URL-extraction AI fallback and 5028'd the intent
//     classifier on inbound email. The deprecation surfaced slowly
//     because the model id was duplicated across three call sites
//     (K28). Centralizing here makes the next sunset one edit, not three.
//   @cf/meta/llama-3.3-70b-instruct-fp8-fast (2026-06-16, K28) — current
//     replacement. Chosen for: (a) same Llama family as the prior model,
//     so it returns `{ response: <string> }` like 3.1-8b did — avoiding
//     the non-string `.response` shape that the 2026-05-22 llama-3.2-3b
//     experiment hit (which crashed the classifier on `.replace`); (b)
//     strong JSON instruction-following for our structured-output
//     dependence; (c) the fp8-fast variant is latency-optimized, which
//     keeps it inside the classifier's 4000ms budget; (d) a 24,000-token
//     context window comfortably covers our 20KB-truncated prompts.
//
// When the next deprecation lands, edit this one constant. (A future
// option, if we want to roll models without a redeploy, is to read an
// env-var override at each call site and fall back to this default.)
export const WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// ── Event statuses ────────────────────────────────────────────────

export const EVENT_STATUS = {
  DRAFT: "DRAFT",
  PENDING: "PENDING",
  TENTATIVE: "TENTATIVE",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  CANCELLED: "CANCELLED",
} as const;

export type EventStatus = (typeof EVENT_STATUS)[keyof typeof EVENT_STATUS];

/** Tuple form for Zod enums and other Array-like consumers. */
export const EVENT_STATUS_VALUES = Object.values(EVENT_STATUS) as readonly EventStatus[];

/** Statuses visible on public pages.
 *
 *  Legacy gate — kept for backward compat. New code should use
 *  `publicEventWhere()` from `src/lib/event-lifecycle.ts` which combines
 *  this editorial gate with the lifecycle gate. The plan was to drop
 *  TENTATIVE here once it migrated to the lifecycle column, but we leave
 *  it in to keep the legacy check identical to current production
 *  behavior — anything visible BEFORE the lifecycle migration must stay
 *  visible AFTER, even on read paths that haven't been upgraded yet. */
export const PUBLIC_EVENT_STATUSES = [EVENT_STATUS.APPROVED, EVENT_STATUS.TENTATIVE] as const;

// ── Event lifecycle (real-world status, orthogonal to editorial) ──

export const EVENT_LIFECYCLE = {
  SCHEDULED: "SCHEDULED",
  TENTATIVE: "TENTATIVE",
  POSTPONED: "POSTPONED",
  RESCHEDULED: "RESCHEDULED",
  CANCELLED: "CANCELLED",
  OCCURRED: "OCCURRED",
  MOVED_ONLINE: "MOVED_ONLINE",
  NO_SHOW: "NO_SHOW",
} as const;
export type EventLifecycle = (typeof EVENT_LIFECYCLE)[keyof typeof EVENT_LIFECYCLE];
export const EVENT_LIFECYCLE_VALUES = Object.values(EVENT_LIFECYCLE) as readonly EventLifecycle[];

/** Lifecycle states that allow public visibility — combined with the
 *  editorial APPROVED check via `publicEventWhere()` in
 *  src/lib/event-lifecycle.ts. CANCELLED and NO_SHOW are deliberately
 *  excluded; OCCURRED stays public as evergreen SEO content. */
export const PUBLIC_LIFECYCLE_STATUSES = [
  EVENT_LIFECYCLE.SCHEDULED,
  EVENT_LIFECYCLE.TENTATIVE,
  EVENT_LIFECYCLE.POSTPONED,
  EVENT_LIFECYCLE.RESCHEDULED,
  EVENT_LIFECYCLE.OCCURRED,
  EVENT_LIFECYCLE.MOVED_ONLINE,
] as const;

/**
 * State-machine transitions for `events.lifecycle_status`.
 *
 * ── Why this lives in constants (OPE-487, 2026-08-25) ────────────────────
 *
 * It used to exist TWICE — `src/lib/event-lifecycle.ts` for the API route and
 * `mcp-server/src/lifecycle.ts` for the `update_event_lifecycle` tool — kept in
 * sync BY HAND, with the mcp copy's own header admitting "CI doesn't catch
 * drift". That is a poor arrangement for an ordinary lookup table and a bad one
 * for a SAFETY GUARD: the failure mode is one copy widened and the other not,
 * which reads as "the rule is enforced" from whichever side you happen to test.
 *
 * ⚠️ A THIRD writer does not consult this table at all: the K27 OCCURRED sweep
 * (`mcp-server/src/event-occurred-sweep.ts`) sets `lifecycle_status = 'OCCURRED'`
 * with a direct UPDATE. The mcp copy's header claimed the sweep shared it; it
 * never imported it. That is tolerable today — the sweep only makes
 * SCHEDULED/RESCHEDULED/MOVED_ONLINE → OCCURRED, all legal here, and it does
 * stamp `lifecycle_status_changed_at` and a reason — but it is an unguarded
 * write path, and worth knowing before anyone assumes this table is the only
 * way the column changes.
 *
 * The earlier objection to moving it here was that doing so "would pull in the
 * Drizzle-dependent publicEventWhere()". That is true of the whole module and
 * false of this map: the transitions and their validator are pure. This package
 * has no dependencies, and `mcp-server/src/lifecycle.ts` already imported
 * `EventLifecycle` from it. `publicEventWhere()` stays in the app.
 *
 * ── The rules ────────────────────────────────────────────────────────────
 *
 *  - SCHEDULED can transition to anything (the catch-all starting state).
 *  - CANCELLED → SCHEDULED is allowed (uncancellation). Rare but real.
 *  - OCCURRED ↔ NO_SHOW only — both are terminal for the event itself, but
 *    admins can correct between them if reality didn't match the backfill.
 *  - **OCCURRED and NO_SHOW are reachable only from a state in which the event
 *    was CONFIRMED to be going ahead** — SCHEDULED, RESCHEDULED, MOVED_ONLINE.
 *
 * ⚠️ That last rule is the one people try to "fix", so it is worth stating why
 * TENTATIVE is excluded (OPE-675, asked and answered 2026-08-31).
 *
 * A tentative event is one we never confirmed was happening. Marking it
 * OCCURRED asserts it took place, and marking it NO_SHOW asserts it did not —
 * both are claims nobody made. The truthful lifecycle for an elapsed
 * unconfirmed event is TENTATIVE: over, and never corroborated.
 *
 * This is not incidental. The K27 OCCURRED sweep measured the population (126
 * past+TENTATIVE rows), deliberately declined to widen its Pass 1 to include
 * them, and widened Pass 3 instead — see the reasoning at
 * `mcp-server/src/event-occurred-sweep.ts` under "past + TENTATIVE". Adding
 * TENTATIVE → OCCURRED here would silently overturn that decision.
 *
 * The earlier wording of this rule said "no transition INTO OCCURRED from a
 * future-state lifecycle except via RESCHEDULED, and SCHEDULED →", which the
 * table itself contradicted: MOVED_ONLINE has both. The rule was never about
 * whether a state points forward; it is about whether the event was confirmed.
 */
export const LIFECYCLE_TRANSITIONS: Record<EventLifecycle, EventLifecycle[]> = {
  SCHEDULED: [
    EVENT_LIFECYCLE.TENTATIVE,
    EVENT_LIFECYCLE.POSTPONED,
    EVENT_LIFECYCLE.RESCHEDULED,
    EVENT_LIFECYCLE.CANCELLED,
    EVENT_LIFECYCLE.MOVED_ONLINE,
    EVENT_LIFECYCLE.OCCURRED,
    EVENT_LIFECYCLE.NO_SHOW,
  ],
  TENTATIVE: [
    EVENT_LIFECYCLE.SCHEDULED,
    EVENT_LIFECYCLE.POSTPONED,
    EVENT_LIFECYCLE.CANCELLED,
    EVENT_LIFECYCLE.MOVED_ONLINE,
  ],
  POSTPONED: [EVENT_LIFECYCLE.SCHEDULED, EVENT_LIFECYCLE.RESCHEDULED, EVENT_LIFECYCLE.CANCELLED],
  RESCHEDULED: [
    EVENT_LIFECYCLE.SCHEDULED,
    EVENT_LIFECYCLE.POSTPONED,
    EVENT_LIFECYCLE.CANCELLED,
    EVENT_LIFECYCLE.OCCURRED,
    EVENT_LIFECYCLE.NO_SHOW,
  ],
  CANCELLED: [EVENT_LIFECYCLE.SCHEDULED, EVENT_LIFECYCLE.RESCHEDULED],
  MOVED_ONLINE: [EVENT_LIFECYCLE.CANCELLED, EVENT_LIFECYCLE.OCCURRED, EVENT_LIFECYCLE.NO_SHOW],
  OCCURRED: [EVENT_LIFECYCLE.NO_SHOW],
  NO_SHOW: [EVENT_LIFECYCLE.OCCURRED],
};

/** The two states the table treats as terminal for the event itself. */
export const TERMINAL_LIFECYCLE_STATUSES = [
  EVENT_LIFECYCLE.OCCURRED,
  EVENT_LIFECYCLE.NO_SHOW,
] as const;

/**
 * Row facts needed to judge whether a terminal value is a RECORD of something
 * that happened, or a value that merely arrived on the row. Optional at every
 * call site: omit it and the strict table applies, which is the safe default
 * for a caller that has not thought about this.
 */
export interface LifecycleTransitionContext {
  /** `events.lifecycle_status_changed_at`. NULL ⇒ never explicitly transitioned. */
  lifecycleStatusChangedAt?: Date | null;
  /** `events.start_date`. */
  startDate?: Date | null;
  /** Injectable clock, for tests. */
  now?: Date;
}

export type TransitionResult =
  | { ok: true; terminalCorrection?: boolean }
  | {
      ok: false;
      reason: string;
      allowed: readonly EventLifecycle[];
      /**
       * OPE-675 — the shortest legal path to the target, when one exists.
       * `allowed` answers "what can I do from here"; this answers "how do I
       * get where I asked to go", which is what the caller actually wanted.
       */
      route?: readonly EventLifecycle[] | null;
      /** Prose for the operator, including what the detour costs. */
      hint?: string;
    };

/**
 * OPE-487 — is this terminal value provably spurious rather than merely
 * unrecorded?
 *
 * BOTH conditions are required, and the conjunction is the whole design:
 *
 *   1. `lifecycle_status_changed_at IS NULL` — nothing ever transitioned the
 *      row, so the value arrived with an import rather than recording an event.
 *   2. `start_date` is in the FUTURE — the terminal value cannot be true.
 *
 * Condition 1 alone is nowhere near sufficient, and the production numbers say
 * so plainly. Measured 2026-08-25 across live rows in a terminal state:
 *
 *     641  terminal rows
 *     194  with a NULL changed_at
 *     191  of those are PAST events — correctly backfilled OCCURRED
 *       3  are future-dated — the actual defect
 *
 * So a NULL-only rule would make 194 rows correctable to reach 3, and 191 of
 * the ones it opened are genuinely-occurred fairs. Resurrecting a past event is
 * the exact failure this lane has already caused once (a tombstone brought back
 * on 2026-08-17), and the terminal states exist to prevent it. The date check is
 * what separates "we have no record of the transition" from "the transition
 * cannot have happened".
 */
function isSpuriousTerminalValue(
  from: EventLifecycle,
  context: LifecycleTransitionContext | undefined
): boolean {
  if (!context) return false;
  if (!(TERMINAL_LIFECYCLE_STATUSES as readonly string[]).includes(from)) return false;
  // An explicit transition timestamp means a human or a sweep decided this.
  if (context.lifecycleStatusChangedAt != null) return false;
  const start = context.startDate;
  if (!start || Number.isNaN(start.getTime())) return false;
  const now = context.now ?? new Date();
  return start.getTime() > now.getTime();
}

/**
 * The shortest legal path from `from` to `to`, or null when there is none.
 *
 * OPE-675 — the refusal used to say only which targets were legal from here,
 * which answers "what CAN I do" and not "how do I get where I asked to go".
 * A caller told `TENTATIVE → OCCURRED is not permitted` has to reconstruct the
 * two-hop route from the table, and an unattended run simply gives up and
 * leaves the row where it started.
 *
 * Breadth-first, so the answer is the shortest route and the search terminates
 * on a table with cycles (CANCELLED ↔ SCHEDULED, OCCURRED ↔ NO_SHOW).
 */
export function lifecycleRoute(from: EventLifecycle, to: EventLifecycle): EventLifecycle[] | null {
  if (from === to) return null;
  const queue: EventLifecycle[][] = [[from]];
  const seen = new Set<EventLifecycle>([from]);
  while (queue.length > 0) {
    const path = queue.shift()!;
    for (const next of LIFECYCLE_TRANSITIONS[path[path.length - 1]] ?? []) {
      if (seen.has(next)) continue;
      const extended = [...path, next];
      if (next === to) return extended;
      seen.add(next);
      queue.push(extended);
    }
  }
  return null;
}

/**
 * Why a refused transition was refused, in words a caller can act on.
 *
 * The route is offered, NOT recommended. Reaching OCCURRED from TENTATIVE
 * means passing through SCHEDULED, which writes "this event is going to
 * happen" onto an event whose date has passed — a false statement that lands
 * in `admin_actions` permanently. So the hint names the intermediate state and
 * says what asserting it costs, rather than presenting the detour as the
 * answer.
 */
export function describeLifecycleRefusal(
  from: EventLifecycle,
  to: EventLifecycle
): { allowed: EventLifecycle[]; route: EventLifecycle[] | null; hint: string } {
  const allowed = LIFECYCLE_TRANSITIONS[from] ?? [];
  const route = lifecycleRoute(from, to);
  if (!route) {
    return { allowed, route: null, hint: `${to} is not reachable from ${from} at all.` };
  }
  const via = route.slice(1, -1);
  return {
    allowed,
    route,
    hint:
      `${to} is reachable via ${route.join(" → ")}, but each hop is a real ` +
      `transition: it writes an admin_actions row and its own lifecycle_reason. ` +
      `Passing through ${via.join(", ")} asserts that state on the record. ` +
      `Only take the route if the intermediate state is TRUE of this event.`,
  };
}

/**
 * Validates that a lifecycle transition is permitted. Use server-side in EVERY
 * write surface before persisting.
 *
 * Pass `context` to enable the OPE-487 terminal-correction escape; without it
 * the strict table applies unchanged, so every existing caller keeps its
 * current behaviour until it opts in.
 */
export function validateLifecycleTransition(
  from: EventLifecycle,
  to: EventLifecycle,
  context?: LifecycleTransitionContext
): TransitionResult {
  if (from === to) {
    return { ok: false, reason: "no-op transition", allowed: LIFECYCLE_TRANSITIONS[from] };
  }
  const allowed = LIFECYCLE_TRANSITIONS[from] ?? [];
  if (allowed.includes(to)) return { ok: true };

  // The escape is deliberately one-directional: it lets a spurious terminal
  // value be corrected to a NON-terminal one. It never creates a new terminal
  // value, so it cannot be used to mark something occurred.
  if (
    isSpuriousTerminalValue(from, context) &&
    !(TERMINAL_LIFECYCLE_STATUSES as readonly string[]).includes(to)
  ) {
    return { ok: true, terminalCorrection: true };
  }

  const refusal = describeLifecycleRefusal(from, to);
  return {
    ok: false,
    reason: `transition ${from} → ${to} is not permitted`,
    allowed,
    route: refusal.route,
    hint: refusal.hint,
  };
}

// ── Venue statuses ────────────────────────────────────────────────

export const VENUE_STATUS = {
  ACTIVE: "ACTIVE",
  INACTIVE: "INACTIVE",
} as const;
export type VenueStatus = (typeof VENUE_STATUS)[keyof typeof VENUE_STATUS];

// ── User roles ────────────────────────────────────────────────────

export const USER_ROLE = {
  ADMIN: "ADMIN",
  PROMOTER: "PROMOTER",
  VENDOR: "VENDOR",
  USER: "USER",
} as const;
export type UserRole = (typeof USER_ROLE)[keyof typeof USER_ROLE];

// ── Event-vendor application statuses (lifecycle) ─────────────────

export const EVENT_VENDOR_STATUS = {
  INVITED: "INVITED",
  INTERESTED: "INTERESTED",
  APPLIED: "APPLIED",
  WAITLISTED: "WAITLISTED",
  APPROVED: "APPROVED",
  CONFIRMED: "CONFIRMED",
  REJECTED: "REJECTED",
  WITHDRAWN: "WITHDRAWN",
  CANCELLED: "CANCELLED",
} as const;
export type EventVendorStatus = (typeof EVENT_VENDOR_STATUS)[keyof typeof EVENT_VENDOR_STATUS];

/** Tuple form for Zod enums. */
export const EVENT_VENDOR_STATUS_VALUES = Object.values(
  EVENT_VENDOR_STATUS
) as readonly EventVendorStatus[];

/** Statuses visible to the public (vendor list on event pages). */
export const PUBLIC_VENDOR_STATUSES = [
  EVENT_VENDOR_STATUS.APPROVED,
  EVENT_VENDOR_STATUS.CONFIRMED,
] as const;

// ── Payment statuses (orthogonal to application status) ───────────

export const PAYMENT_STATUS = {
  NOT_REQUIRED: "NOT_REQUIRED",
  PENDING: "PENDING",
  PAID: "PAID",
  REFUNDED: "REFUNDED",
  OVERDUE: "OVERDUE",
} as const;
export type PaymentStatus = (typeof PAYMENT_STATUS)[keyof typeof PAYMENT_STATUS];
export const PAYMENT_STATUS_VALUES = Object.values(PAYMENT_STATUS) as readonly PaymentStatus[];

// ── Event vendor participation mode (drizzle/0071) ────────────────
// Orthogonal to EVENT_VENDOR_STATUS. EXHIBITOR = takes booth space;
// SPONSOR_ONLY = logo/program presence, no booth; SPONSOR_AND_EXHIBITOR
// = both (e.g. venue naming rights + a booth on the floor).

export const PARTICIPATION_TYPE = {
  EXHIBITOR: "EXHIBITOR",
  SPONSOR_ONLY: "SPONSOR_ONLY",
  SPONSOR_AND_EXHIBITOR: "SPONSOR_AND_EXHIBITOR",
} as const;
export type ParticipationType = (typeof PARTICIPATION_TYPE)[keyof typeof PARTICIPATION_TYPE];
export const PARTICIPATION_TYPE_VALUES = Object.values(
  PARTICIPATION_TYPE
) as readonly ParticipationType[];

/** True when the vendor takes booth space (visible in the Exhibitors
 *  section + emitted in schema.org `performer`). */
export function isExhibitor(p: ParticipationType): boolean {
  return p === PARTICIPATION_TYPE.EXHIBITOR || p === PARTICIPATION_TYPE.SPONSOR_AND_EXHIBITOR;
}

/** True when the vendor is a sponsor (visible in the Sponsors section +
 *  emitted in schema.org `sponsor`). */
export function isSponsor(p: ParticipationType): boolean {
  return p === PARTICIPATION_TYPE.SPONSOR_ONLY || p === PARTICIPATION_TYPE.SPONSOR_AND_EXHIBITOR;
}

// ── Blog post statuses ────────────────────────────────────────────

export const BLOG_POST_STATUS = {
  DRAFT: "DRAFT",
  PUBLISHED: "PUBLISHED",
} as const;
export type BlogPostStatus = (typeof BLOG_POST_STATUS)[keyof typeof BLOG_POST_STATUS];

// ── Favoritable polymorphic types ─────────────────────────────────

export const FAVORITABLE_TYPE = {
  EVENT: "EVENT",
  VENUE: "VENUE",
  VENDOR: "VENDOR",
  PROMOTER: "PROMOTER",
} as const;
export type FavoritableType = (typeof FAVORITABLE_TYPE)[keyof typeof FAVORITABLE_TYPE];

// ── Indoor/outdoor designation ────────────────────────────────────

export const INDOOR_OUTDOOR = {
  INDOOR: "INDOOR",
  OUTDOOR: "OUTDOOR",
  MIXED: "MIXED",
} as const;
export type IndoorOutdoor = (typeof INDOOR_OUTDOOR)[keyof typeof INDOOR_OUTDOOR];

// ── Event scale (rough size categories) ───────────────────────────

export const EVENT_SCALE = {
  SMALL: "SMALL",
  MEDIUM: "MEDIUM",
  LARGE: "LARGE",
  MAJOR: "MAJOR",
} as const;
export type EventScale = (typeof EVENT_SCALE)[keyof typeof EVENT_SCALE];

// ── Event categories (advisory taxonomy for dropdowns/filters) ────

export const EVENT_CATEGORIES = [
  "Agricultural Fair",
  // OPE-186 (2026-07-13) — large non-fair public spectacles had no taxonomy
  // lane, so air shows / balloon festivals landed as free-text or ["Event"] in
  // the uncategorized queue (the Great State of Maine Air Show + Great Falls
  // Balloon Festival were both un-modelable). "Balloon Festival" is added below.
  "Air Show",
  "Antique Show",
  // K21 (2026-06-12). Reconciled the allow-list against live prod
  // data: 90 distinct category values were in use on APPROVED events
  // vs 18 here, so suggest_event was silently coercing common, valid
  // categories (Fair, Art Show, Gun Show, Parade, …) to ["Event"].
  // Added the 14 highest-frequency clean values below. Near-duplicate
  // clusters (Renaissance Fair/Faire, Wedding Show/Expo, Cultural,
  // Pop Culture Convention, generic "Market") are left for a TAX1
  // dedupe pass — suggest_event now surfaces them via
  // warnings.dropped_categories instead of dropping them silently.
  "Art Fair",
  "Art Show",
  "Art Walk",
  "Balloon Festival", // OPE-186 — hot-air balloon festivals/rallies (spectacle lane)
  "Beer Festival",
  "Boat Show",
  "Bridal Show",
  "Car Show",
  // TAX1 A10 (2026-06-02): "Charity" and "Community Event" are kept as
  // two first-class values (not collapsed to one + a charity tag) so
  // category-browse pages and the picker UI surface them separately —
  // charitable events have different vendor / attendee semantics than
  // general community gatherings.
  "Charity",
  "Comic Con",
  "Community Event",
  "Convention",
  "Craft Fair",
  "Craft Show",
  "Cultural Festival",
  "Fair",
  "Farmers Market",
  "Festival",
  "Fiber Arts Festival",
  "Flea Market",
  "Food Festival",
  "Garden Show",
  "Gun Show",
  "Harvest Festival",
  "Holiday Market",
  "Home Show",
  "Makers Market",
  "Music Festival",
  "Parade",
  "Trade Show",
  "Other",
] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

// ── OPE-13 vendor-roster rails ────────────────────────────────────
//
// Per-event roster-research lifecycle. NULL (absent here) = never
// evaluated. NEEDS_RESEARCH is the enqueue state (set by the just-
// occurred sweep); the other three are terminal states the research
// worker writes via set_vendor_roster_status. NO_PUBLIC_LIST is the
// "sticky dead-end" that makes the backfill converge; PARTIAL pairs
// with events.vendor_roster_offset to resume an incomplete run.
export const VENDOR_ROSTER_STATUS_VALUES = [
  "NEEDS_RESEARCH",
  "HAS_ROSTER",
  "NO_PUBLIC_LIST",
  "PARTIAL",
  // OPE-498 — "a public list exists, but not in the served HTML."
  //
  // Distinct from PARTIAL, which means "a run stopped and can resume at
  // vendor_roster_offset", and distinct from NO_PUBLIC_LIST, which means the
  // roster is not published at all. Measured 2026-08-20: ALL FIVE PARTIAL rows
  // had vendor_roster_offset == vendor_count, because the offset was not a
  // stopping point — it was the entire payload a server-side fetch receives.
  // Guilford proves it: the Artrider page serves exactly 25 artists in its HTML
  // while its own copy says the show has 175.
  //
  // The distinction is load-bearing because a PARTIAL with a source_url and an
  // offset is the CHEAPEST-LOOKING item in the drain — no search needed, just
  // resume — so every pass reached for these five, re-fetched the identical
  // first page, and wrote the same offset back. A rail that cannot express
  // "unreachable by this method" mis-sells a capability gap as queue work.
  "NEEDS_RENDERED_FETCH",
  // OPE-527 — "this event holds roster-grade vendor links, but nobody
  // researched them and nothing records where they came from."
  //
  // The distinction HAS_ROSTER cannot make. HAS_ROSTER is TERMINAL: the drain
  // never re-selects it. So writing it for a row we merely COUNTED converts a
  // visible gap (a populated row still reading NEEDS_RESEARCH, which is safe
  // and self-correcting the moment anyone looks) into an invisible one (a
  // permanent claim that a roster was researched, with no record of the
  // source). OPE-525's sweep guard did exactly that to 14 rows before this
  // value existed.
  //
  // Deliberately does NOT stamp vendor_roster_checked_at: no check occurred,
  // and a timestamp would be a second unattributed claim. Like HAS_ROSTER it
  // is not re-enqueued by the occurred sweep — the point is to stop burning
  // passes on rosters we already hold — but unlike HAS_ROSTER it is honest
  // about never having been verified, and a drain can target it deliberately.
  "HAS_LINKS_UNVERIFIED",
] as const;
export type VendorRosterStatus = (typeof VENDOR_ROSTER_STATUS_VALUES)[number];

// OPE-123 — per-event PERFORMER-lineup research state (the performer analog of
// vendor_roster_status). NEEDS_RESEARCH = lineup not yet re-verified; VERIFIED =
// lineup re-grounded against a source; NO_LINEUP_PUBLISHED = researched dead-end
// (sticky, so the sweep converges instead of re-checking events with no findable
// lineup). Terminal statuses (everything but NEEDS_RESEARCH) stamp
// performer_roster_checked_at.
export const PERFORMER_ROSTER_STATUS_VALUES = [
  "NEEDS_RESEARCH",
  "VERIFIED",
  "NO_LINEUP_PUBLISHED",
] as const;
export type PerformerRosterStatus = (typeof PERFORMER_ROSTER_STATUS_VALUES)[number];

/**
 * OPE-709 — the application ROUTES an event can publish. One event routinely has
 * several, and until now `events.application_url` held exactly one.
 *
 * All 105 rows carrying an `application_url` on 2026-08-31 were the COMMERCIAL
 * lane — booth space for a business. Zero were exhibitor entries. That is not a
 * coverage gap: every county fair here has a few dozen commercial vendors and
 * HUNDREDS of exhibitors (bakers, quilters, photographers, 4-H animals), and the
 * single field was built for the smaller half.
 *
 * The lanes are genuinely different products, not variants: a booth costs
 * hundreds of dollars and closes months ahead; an exhibit entry costs $1–2 and
 * closes two to four weeks out, through a different department.
 */
export const EVENT_APPLICATION_LANES = [
  /** Booth space for a business. The lane `events.application_url` always held. */
  "commercial_vendor",
  /** Entering an item to be judged — premium books, exhibit halls, contests. */
  "exhibitor_competition",
  /** Acts, bands, demonstrations. */
  "performer",
  /** Help at the fair. */
  "volunteer",
] as const;
export type EventApplicationLane = (typeof EVENT_APPLICATION_LANES)[number];

// "Producer-class" events — the big PRODUCED shows that publish a
// web exhibitor directory worth backfilling (home/garden, boat/RV,
// sportsman, trade, fiber, craft-festival, fairs). Deliberately
// EXCLUDES recurring markets (Farmers/Flea/Holiday/Makers Market)
// and one-off community gatherings, which almost never publish a
// findable roster. This is the denominator for the roster coverage
// metric (OPE-13 Part 3) — drawn from EVENT_CATEGORIES values so the
// filter matches the JSON `events.categories` array by construction.
export const PRODUCER_CLASS_CATEGORIES = [
  "Agricultural Fair",
  "Antique Show",
  "Boat Show",
  "Car Show",
  "Craft Fair",
  "Craft Show",
  "Fair",
  "Fiber Arts Festival",
  "Garden Show",
  "Gun Show",
  "Home Show",
  "Trade Show",
] as const satisfies readonly EventCategory[];
export type ProducerClassCategory = (typeof PRODUCER_CLASS_CATEGORIES)[number];

/**
 * OPE-525/527 — how many non-sponsor vendor links count as "we already hold
 * this roster", so the occurred-sweep stamps HAS_LINKS_UNVERIFIED instead of
 * queueing the event for research it does not need.
 *
 * 10 is drawn from the prod distribution of the rows this fixed, not picked for
 * roundness. Of the 34 already-linked events the sweep had stamped
 * NEEDS_RESEARCH, 15 carried >=10 non-sponsor links and held 1,396 of the 1,440
 * links between them (97%); the remaining 19 held 44 links, thirteen of them
 * three or fewer. So the threshold separates "an ingested exhibitor list" from
 * "a couple of vendors we happen to know about", and the latter genuinely does
 * still need research — re-surfacing those is correct, not a bug.
 *
 * Corroborated independently 2026-08-26 (OPE-547): across all 66 rows a human
 * researcher has ever stamped HAS_ROSTER, the MINIMUM link count is 8 and every
 * one of them holds 5+. Nobody has ever called a 1–4 link event a roster.
 *
 * OPE-547 moved this out of `mcp-server/src/event-occurred-sweep.ts` so the
 * writer that applies it and the metric that reports against it share one
 * number. They were about to be two.
 */
export const ROSTER_EVIDENCE_MIN = 10;

// ── TAX1 Phase 1 — audience / access enums ────────────────────────
//
// Orthogonal to EVENT_CATEGORIES (what an event IS) and to vendor-
// access flags (who can SELL). Defaults are the permissive value so
// the 2026-06-02 migration is invisible: every pre-migration row
// reads as PUBLIC + OPEN, preserving today's semantics. See
// drizzle/0100_events_audience_access.sql + events.primaryAudience
// in packages/db-schema/src/index.ts.

export const PRIMARY_AUDIENCE = ["PUBLIC", "TRADE", "MEMBERS"] as const;
export type PrimaryAudience = (typeof PRIMARY_AUDIENCE)[number];

export const PUBLIC_ACCESS = ["OPEN", "CLOSED"] as const;
export type PublicAccess = (typeof PUBLIC_ACCESS)[number];

// ── Event-vendor status transition state machine ──────────────────
// Used by both the admin event-vendor PATCH endpoint (main app) and the
// MCP update_event_vendor tool. Single source of truth so the rules don't
// drift between the two write paths.

export const VENDOR_STATUS_TRANSITIONS: Record<EventVendorStatus, EventVendorStatus[]> = {
  INVITED: ["INTERESTED", "APPLIED", "REJECTED", "WITHDRAWN", "CANCELLED"],
  INTERESTED: ["APPLIED", "WITHDRAWN", "CANCELLED"],
  APPLIED: ["WAITLISTED", "APPROVED", "CONFIRMED", "REJECTED", "WITHDRAWN"],
  WAITLISTED: ["APPROVED", "CONFIRMED", "REJECTED", "WITHDRAWN", "CANCELLED"],
  APPROVED: ["CONFIRMED", "REJECTED", "WITHDRAWN", "CANCELLED"],
  CONFIRMED: ["WITHDRAWN", "CANCELLED"],
  REJECTED: ["APPLIED", "INVITED"],
  WITHDRAWN: ["APPLIED", "INTERESTED"],
  CANCELLED: ["INVITED"],
};

// ── OPE-35 promoter-enrichment rails ──────────────────────────────
//
// Per-promoter enrichment lifecycle — the promoter analog of the
// vendor-roster rails (VENDOR_ROSTER_STATUS_VALUES above). NULL (absent)
// = never assessed. NEEDS_ENRICHMENT is the enqueue state (set by the
// create/update hook when a website exists but a target field is empty);
// ENRICHED/NO_SOURCE are derived-terminal; IN_PROGRESS/BLOCKED are
// agent/operator-owned "sticky" states the enqueue hook preserves.
export const PROMOTER_ENRICHMENT_STATUS_VALUES = [
  "NEEDS_ENRICHMENT",
  "IN_PROGRESS",
  "ENRICHED",
  "NO_SOURCE",
  "BLOCKED",
] as const;
export type PromoterEnrichmentStatus = (typeof PROMOTER_ENRICHMENT_STATUS_VALUES)[number];

// The five enrichment target fields tracked in `promoters.enrichment_coverage`
// (a JSON snapshot of which are filled). Fill-rate metrics aggregate these.
export const PROMOTER_ENRICHMENT_FIELDS = [
  "hero",
  "logo",
  "description",
  "socials",
  "contact",
] as const;
export type PromoterEnrichmentField = (typeof PROMOTER_ENRICHMENT_FIELDS)[number];

// Why a NEEDS_ENRICHMENT promoter can't be drained — set alongside BLOCKED.
export const PROMOTER_ENRICHMENT_BLOCKED_REASONS = [
  "js_gated",
  "host_gated",
  "parked",
  "hijacked",
  "no_image",
  "stale",
  "rate_limited",
] as const;
export type PromoterEnrichmentBlockedReason = (typeof PROMOTER_ENRICHMENT_BLOCKED_REASONS)[number];

export type PromoterEnrichmentCoverage = Record<PromoterEnrichmentField, boolean>;

export interface PromoterEnrichmentInput {
  website?: string | null;
  heroImageUrl?: string | null;
  logoUrl?: string | null;
  description?: string | null;
  socialLinks?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
}

export interface PromoterEnrichmentResult {
  status: PromoterEnrichmentStatus;
  coverage: PromoterEnrichmentCoverage;
  /** JSON string for direct write to `promoters.enrichment_coverage`. */
  coverageJson: string;
}

function enrichmentHasText(v: string | null | undefined): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

function enrichmentHasSocials(v: string | null | undefined): boolean {
  if (!enrichmentHasText(v)) return false;
  const t = v!.trim();
  // social_links is a JSON string; empty containers / literal null count as absent.
  return t !== "[]" && t !== "{}" && t.toLowerCase() !== "null";
}

/**
 * A description counts as "missing" for enrichment when it's blank OR an
 * auto-generated placeholder, so curated descriptions aren't re-queued but
 * boilerplate ones are (OPE-35 note). Conservative by design — the auto-
 * generated promoter descriptions produced this session took the shape
 * "Event organizer." / "<Name> is an event organizer."
 */
export function isPlaceholderDescription(desc: string | null | undefined): boolean {
  if (!enrichmentHasText(desc)) return true;
  const d = desc!.trim();
  if (/^event organizer\.?$/i.test(d)) return true;
  if (/\bis an event organizer\b/i.test(d) && d.length < 60) return true;
  return false;
}

/**
 * Derive a promoter's enrichment status + per-field coverage from its fields.
 * Pure — the single source of truth for the create/update enqueue hook (OPE-35).
 *
 * - all five fields covered → ENRICHED (even if it was IN_PROGRESS/BLOCKED)
 * - no website → NO_SOURCE (nothing to enrich from)
 * - IN_PROGRESS/BLOCKED preserved on edits that don't complete coverage
 *   (mirrors vendor-roster not overwriting terminal states on re-sweep)
 * - otherwise → NEEDS_ENRICHMENT
 */
export function computePromoterEnrichment(
  p: PromoterEnrichmentInput,
  currentStatus?: PromoterEnrichmentStatus | null
): PromoterEnrichmentResult {
  const coverage: PromoterEnrichmentCoverage = {
    hero: enrichmentHasText(p.heroImageUrl),
    logo: enrichmentHasText(p.logoUrl),
    description: !isPlaceholderDescription(p.description),
    socials: enrichmentHasSocials(p.socialLinks),
    contact: enrichmentHasText(p.contactEmail) || enrichmentHasText(p.contactPhone),
  };
  const allCovered = PROMOTER_ENRICHMENT_FIELDS.every((f) => coverage[f]);
  const hasWebsite = enrichmentHasText(p.website);

  let status: PromoterEnrichmentStatus;
  if (allCovered) {
    status = "ENRICHED";
  } else if (!hasWebsite) {
    status = "NO_SOURCE";
  } else if (currentStatus === "IN_PROGRESS" || currentStatus === "BLOCKED") {
    status = currentStatus;
  } else {
    status = "NEEDS_ENRICHMENT";
  }

  return { status, coverage, coverageJson: JSON.stringify(coverage) };
}

// ── OPE-116 performer-enrichment rails ────────────────────────────
//
// Per-performer enrichment lifecycle — the performer analog of the promoter
// rails above. Same five-state model; the only shape difference is the field
// set: a performer has a SINGLE `image_url` (no hero/logo split) plus
// description / socials / contact. Unlike promoters, a performer description
// has no auto-generated boilerplate to detect, so "missing description" is
// simply blank.
export const PERFORMER_ENRICHMENT_STATUS_VALUES = [
  "NEEDS_ENRICHMENT",
  "IN_PROGRESS",
  "ENRICHED",
  "NO_SOURCE",
  "BLOCKED",
] as const;
export type PerformerEnrichmentStatus = (typeof PERFORMER_ENRICHMENT_STATUS_VALUES)[number];

// The four enrichment target fields tracked in `performers.enrichment_coverage`.
export const PERFORMER_ENRICHMENT_FIELDS = ["image", "description", "socials", "contact"] as const;
export type PerformerEnrichmentField = (typeof PERFORMER_ENRICHMENT_FIELDS)[number];

// Why a NEEDS_ENRICHMENT performer can't be drained — set alongside BLOCKED.
// Same vocabulary as promoters (the dispatcher maps only host_gated/js_gated/
// stale, but the wider set stays available for operator/agent annotation).
export const PERFORMER_ENRICHMENT_BLOCKED_REASONS = [
  "js_gated",
  "host_gated",
  "parked",
  "hijacked",
  "no_image",
  "stale",
  "rate_limited",
] as const;
export type PerformerEnrichmentBlockedReason =
  (typeof PERFORMER_ENRICHMENT_BLOCKED_REASONS)[number];

export type PerformerEnrichmentCoverage = Record<PerformerEnrichmentField, boolean>;

export interface PerformerEnrichmentInput {
  website?: string | null;
  imageUrl?: string | null;
  description?: string | null;
  socialLinks?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
}

export interface PerformerEnrichmentResult {
  status: PerformerEnrichmentStatus;
  coverage: PerformerEnrichmentCoverage;
  /** JSON string for direct write to `performers.enrichment_coverage`. */
  coverageJson: string;
}

/**
 * Derive a performer's enrichment status + per-field coverage from its fields.
 * Pure — the single source of truth for the enrich_performer recompute + the
 * review-apply path. Mirrors computePromoterEnrichment's terminal-state rules.
 *
 * - all four fields covered → ENRICHED
 * - no website → NO_SOURCE (nothing to enrich from)
 * - IN_PROGRESS/BLOCKED preserved on edits that don't complete coverage
 * - otherwise → NEEDS_ENRICHMENT
 */
export function computePerformerEnrichment(
  p: PerformerEnrichmentInput,
  currentStatus?: PerformerEnrichmentStatus | null
): PerformerEnrichmentResult {
  const coverage: PerformerEnrichmentCoverage = {
    image: enrichmentHasText(p.imageUrl),
    description: enrichmentHasText(p.description),
    socials: enrichmentHasSocials(p.socialLinks),
    contact: enrichmentHasText(p.contactEmail) || enrichmentHasText(p.contactPhone),
  };
  const allCovered = PERFORMER_ENRICHMENT_FIELDS.every((f) => coverage[f]);
  const hasWebsite = enrichmentHasText(p.website);

  let status: PerformerEnrichmentStatus;
  if (allCovered) {
    status = "ENRICHED";
  } else if (!hasWebsite) {
    status = "NO_SOURCE";
  } else if (currentStatus === "IN_PROGRESS" || currentStatus === "BLOCKED") {
    status = currentStatus;
  } else {
    status = "NEEDS_ENRICHMENT";
  }

  return { status, coverage, coverageJson: JSON.stringify(coverage) };
}

// ---------------------------------------------------------------------------
// OPE-370 — search-ping retention
// ---------------------------------------------------------------------------

/**
 * How long an un-submitted IndexNow ping stays worth submitting.
 *
 * John ruled on 2026-07-18 that anything older than 7 days gets discarded at
 * breaker-clear time, on SEO-recency grounds. Lives here, in the shared
 * constants package, because BOTH the prune (mcp-server) and the OPE-243 §1
 * drain read it — two independent copies of "7" would drift, and the drain
 * submitting a window the prune has already emptied is a silent no-op.
 *
 * MEASURED, not inherited (prod, 2026-08-13). Depth is NOT the constraint:
 *
 *   unflushed total ....... 7,764   (oldest 2026-06-14)
 *   within 30 days ...........  910
 *   within 14 days ...........  101
 *   within  7 days ............  45   <- a 7-day window prunes 99.4%
 *
 * Recent enqueue is ~6-7 rows/day, so steady-state depth at 7 days is ~45-50
 * rows. Even a 30-day window holds under 1,000 — comfortably inside a single
 * 10,000-URL IndexNow batch. So the window should be chosen on SEO value
 * alone; queue size does not argue for any particular figure.
 *
 * Kept at 7 because that is the standing ruling and recency is the right
 * criterion. Widening it would cost essentially nothing operationally — noted
 * on OPE-370 as a decision available to John, not taken unilaterally.
 */
export const SEARCH_PING_RETENTION_DAYS = 7;

/** Env override, so the window is tunable without a deploy-time code change. */
export function searchPingRetentionDays(env: { SEARCH_PING_RETENTION_DAYS?: string }): number {
  const raw = Number(env.SEARCH_PING_RETENTION_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : SEARCH_PING_RETENTION_DAYS;
}

/**
 * OPE-532 — inbound reply kinds that TERMINATE the pipeline without producing
 * an event and without leaving anyone owing a reply. The submission is lost.
 *
 * Shared rather than local because two packages need the same answer: the MCP
 * Worker's `inbound-exception-notice` (which counts them for the operator
 * email) and the main app's `queue_drain_snapshots` (which gives OPE-247's
 * frozen-queue alerting something to watch). Two copies of this list is how a
 * fix ends up wired into one of two parallel paths.
 *
 * Deliberately excludes `no-url`: there the sender was asked for a URL and has
 * not answered, so the ball is in their court. That is a different queue.
 */
export const TERMINAL_UNHANDLED_REPLY_KINDS = [
  "photo-intake-unresolved",
  "no-url-prose-failed",
] as const;

/**
 * Inbound statuses meaning a human or a rail has already disposed of the row.
 * `reply_kind` is never rewritten on disposal, so without this an operator
 * rejecting a held photo would leave it counted for ever.
 */
export const DISPOSED_INBOUND_STATUSES = ["rejected", "audit-noop", "salvaged"] as const;

/**
 * OPE-532 ruling part 2 — the AWAITING-SUBMITTER queue, and its expiry.
 *
 * The mirror image of `TERMINAL_UNHANDLED_REPLY_KINDS` above. There, we owe the
 * reply and a human can salvage the row. Here, WE asked and are waiting: the
 * ball is in the submitter's court, so no amount of triage moves it.
 *
 * John's ruling, 2026-08-27: *"Add a bounded no-reply expiry so `no-url` rows
 * (and any 'awaiting submitter' state) auto-close after ~21 days instead of
 * accumulating silently — the real fix, since the state otherwise has no
 * reader."*
 *
 * ── Why this list has exactly one entry ──────────────────────────────────
 *
 * The reopening comment proposed `no-url-prose-failed` as "the obvious
 * sibling". It is not, and the distinction is the whole content of this
 * change. That kind means *we had the content and got nothing out of it* —
 * fault ours, salvageable by a human — which is why it sits in
 * `TERMINAL_UNHANDLED_REPLY_KINDS` above and is counted by the OPE-17 triage
 * notice. Expiring it would silently remove 14 live rows from the queue
 * PR #1010 built to hold them, undoing that fix under a tidier name.
 *
 * `unfetchable-url` is excluded for the same reason, stated in its own module
 * (`no-url-reply-kind.ts`): *"you included one, we couldn't read it. Fault:
 * ours."* An expiry cannot discharge an obligation we hold.
 *
 * ⚠️ `support-ack` is the trap worth naming, because it is structurally
 * IDENTICAL to `no-url` — `status='replied'`, `resulting_event_id` NULL, ageing
 * quietly, 30 live rows at 72 days — and points the opposite way: the customer
 * asked US. A predicate keyed on the row's SHAPE rather than on who owes the
 * reply would auto-close genuine unanswered customer questions and call it
 * hygiene. Key on the obligation, never on the shape.
 */
export const AWAITING_SUBMITTER_REPLY_KINDS = ["no-url"] as const;

/**
 * How long a submitter gets before their silence is taken as an answer.
 *
 * 21 days per the ruling. Long enough that a real person who meant to reply has
 * had several weekends; short enough that the queue has a ceiling. The oldest
 * live row when this shipped was 89 days, so the bound is the point.
 */
export const AWAITING_SUBMITTER_EXPIRY_DAYS = 21;
