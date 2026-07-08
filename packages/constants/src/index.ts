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
