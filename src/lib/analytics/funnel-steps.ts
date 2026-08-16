/**
 * OPE-364 — per-step funnel instrumentation.
 *
 * ── Why steps and not a conversion rate ─────────────────────────────────────
 * OPE-361 broke mobile /register and claim outright and the conversion KPI
 * could not register it: OPE-59 already had the claim funnel at 1 conversion
 * per 5,289 profiles. When a rate is already ~0, going to exactly 0 is not a
 * signal. We found out because the affected vendor personally knew John.
 *
 * Ratios between ADJACENT steps stay informative at any absolute volume and
 * localise the break to one step instead of condemning the whole funnel.
 *
 * ── The step that carries the weight ────────────────────────────────────────
 * `form_interacted`. OPE-361's signature is exactly "page viewed, form never
 * touched" — because the form was off-screen. A funnel counting only views and
 * submissions cannot tell "nobody wanted to" from "nobody could", and those
 * need opposite responses.
 *
 * ── Completeness (NOT-SUMMABLE RULE, mandatory per the ticket) ──────────────
 * These counters are **first-party and near-complete per user, but lossy in the
 * tail**, and must never be presented as exact totals:
 *
 *   • The beacon is rate-limited (`analytics-track`): 60 events/hour anonymous,
 *     120 authenticated, PER CLIENT. Past that the POST is 429'd and the event
 *     is dropped. A single human completing a funnel emits <10 events, so a
 *     normal session is complete; a shared NAT/office IP or a crawler can
 *     exhaust the budget and silently lose events.
 *   • Clients with JavaScript disabled emit nothing.
 *   • Unlike gtag, this is a FIRST-PARTY endpoint, so ad-blockers do not
 *     suppress it — the usual analytics undercount does not apply here.
 *
 * The loss is per-client and applies to every step equally, so **ratios between
 * adjacent steps are far more robust than absolute counts**. Report ratios.
 * That is not a workaround; it is the same reason the ticket asked for steps.
 *
 * Precedent for taking this seriously: GSC dimensioned rows undercounted clicks
 * by 65% and it was caught only by Google's own monthly email.
 */

/** The three funnels OPE-363/364 care about. */
export const FUNNELS = ["register", "claim", "submit"] as const;
export type Funnel = (typeof FUNNELS)[number];

/**
 * Ordered steps per funnel. Order is load-bearing: the read path computes each
 * step's ratio against the step BEFORE it, so a drop localises to one edge.
 *
 * Names are the analytics event names, so the allowlist in
 * /api/analytics/track and this registry cannot drift apart silently.
 */
export const FUNNEL_STEPS: Record<Funnel, readonly string[]> = {
  register: ["register_view", "register_form_interacted", "register_submitted"],
  // `claim_view` / `claim_started` / `claim_submitted` already existed (OPE-66,
  // ENG1.5). Only the interaction step was missing — which is the one that
  // would have caught OPE-361, hence this ticket.
  claim: ["claim_view", "claim_form_interacted", "claim_started", "claim_submitted"],
  // Terminal step is our OWN beacon name, not `suggest_event_public_submit`.
  // `trackFormSubmit` only beacons the newsletter/vendor_claim audiences — the
  // suggest audience is GA4-only — so reusing that name would have left this
  // funnel's last step reading zero in D1 forever. The registry-vs-allowlist
  // drift test caught exactly that on its first run.
  submit: ["submit_view", "submit_form_interacted", "submit_submitted"],
} as const;

/** Every step name, for the beacon allowlist. */
export const ALL_FUNNEL_STEP_NAMES: readonly string[] = Object.values(FUNNEL_STEPS).flat();

/** Steps added by OPE-364 (the rest pre-existed and are already allowlisted). */
export const NEW_FUNNEL_STEP_NAMES = [
  "register_view",
  "register_form_interacted",
  "register_submitted",
  "claim_form_interacted",
  "submit_view",
  "submit_form_interacted",
  "submit_submitted",
] as const;

export type DeviceClass = "mobile" | "tablet" | "desktop" | "unknown";
export type OsFamily = "ios" | "android" | "windows" | "macos" | "linux" | "other" | "unknown";

/**
 * Classify a User-Agent into a device class and OS family.
 *
 * Derived SERVER-SIDE on purpose. The beacon's `properties` are whatever the
 * client posts, so a client-supplied device field is both spoofable and easy to
 * forget to send; deriving it from the request header means the dimension is
 * present on EVERY event for free and cannot be omitted by a caller.
 *
 * OPE-361 was mobile-only AND presented differently on iOS vs Android (off the
 * right edge vs merely shoved right). Without this split, an undimensioned
 * funnel would have shown a modest dip diluted by desktop traffic — which is
 * precisely how it went unnoticed.
 *
 * UA sniffing is approximate by nature and this is deliberately coarse: it
 * answers "which of the three layouts did this user get", not "which handset".
 * Order matters — tablet before mobile, because iPad UAs contain neither
 * "Mobile" reliably nor a desktop marker, and Android tablets say "Android"
 * without "Mobile".
 */
export function classifyDevice(userAgent: string | null | undefined): {
  device: DeviceClass;
  os: OsFamily;
} {
  if (!userAgent || !userAgent.trim()) return { device: "unknown", os: "unknown" };
  const ua = userAgent.toLowerCase();

  const os: OsFamily = /iphone|ipad|ipod/.test(ua)
    ? "ios"
    : /android/.test(ua)
      ? "android"
      : // Check macOS before Windows: some UAs mention both, and "Macintosh"
        // is the more specific token.
        /macintosh|mac os x/.test(ua)
        ? "macos"
        : /windows/.test(ua)
          ? "windows"
          : /linux|x11|cros/.test(ua)
            ? "linux"
            : "other";

  // iPadOS 13+ reports a desktop Safari UA ("Macintosh") and is only
  // distinguishable by touch support, which a header cannot see. Such an iPad
  // lands in "desktop" — a known, accepted limitation, recorded rather than
  // papered over, since it does not affect the phone-vs-desktop split that
  // OPE-361 hinged on.
  const device: DeviceClass = /ipad|android(?!.*mobile)|tablet|kindle|playbook|silk/.test(ua)
    ? "tablet"
    : /iphone|ipod|android.*mobile|windows phone|mobile safari|opera mini|iemobile/.test(ua)
      ? "mobile"
      : /macintosh|windows|linux|x11|cros/.test(ua)
        ? "desktop"
        : "unknown";

  return { device, os };
}

export interface StepCount {
  step: string;
  count: number;
  /** Ratio against the PREVIOUS step. null for the first step (no predecessor). */
  ratioFromPrevious: number | null;
}

/**
 * Turn raw per-step counts into the adjacent-step ratios that make a low-volume
 * funnel readable.
 *
 * A zero predecessor yields `null`, never `0` or `Infinity`: "no one reached
 * this step" is not the same claim as "everyone who reached it dropped", and
 * conflating them is how a quiet funnel gets misread as a broken one.
 */
export function computeStepRatios(funnel: Funnel, counts: Record<string, number>): StepCount[] {
  const steps = FUNNEL_STEPS[funnel];
  return steps.map((step, i) => {
    const count = counts[step] ?? 0;
    if (i === 0) return { step, count, ratioFromPrevious: null };
    const prev = counts[steps[i - 1]] ?? 0;
    return {
      step,
      count,
      ratioFromPrevious: prev > 0 ? count / prev : null,
    };
  });
}
