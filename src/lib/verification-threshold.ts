/**
 * OPE-637 — the verification staleness window, as a STORED parameter.
 *
 * ## What was specified and what shipped
 *
 * John's 2026-08-14 constraints for OPE-177 scope 3 were explicit:
 *
 *   1. the threshold is a stored parameter, "No magic 24/48 baked into code"
 *   2. seed it at 48h
 *   3. self-tune on the observed `email_verified − created_at` distribution,
 *      with a floor and a ceiling
 *
 * What shipped was `const GRACE_H = 24` inside `unconfirmedAuthEmailFlow` —
 * the exact hardcoded constant the instruction ruled out, at half the specified
 * seed — and no comment recorded the constraints as built, dropped or
 * renegotiated. `tunable_thresholds` held four rows on 2026-08-30 and none for
 * this.
 *
 * That matters because this window DECIDES QUEUE MEMBERSHIP. At 24h the queue
 * stood at depth 13; at the specified 48h it is a different, smaller set, and
 * nobody could change it without a deploy.
 *
 * ## Why there is still a number in this file
 *
 * Constraint 1 is about the OPERATIVE value being changeable without a deploy,
 * not about the absence of any literal. A stored config that cannot be read
 * must still resolve to something, and the established house pattern
 * (`queue-freeze-thresholds.ts`, OPE-497 scope 5) is to fail OPEN to a code
 * default: "an unreadable config should not be able to silence a detector."
 *
 * So the default here is 48 — the specified seed, not the 24 that shipped —
 * and it is reached only when the row is missing or malformed.
 *
 * ## The floor and ceiling are the safety property
 *
 * Self-tuning writes to a value that governs an operator alert, so it is
 * bounded on both sides. Below the floor the queue fills with people who
 * registered an hour ago and have not failed at anything yet; above the ceiling
 * a real drop-off problem stays invisible for a week. Per OPE-177's own closing
 * note, this queue is a SIGNAL and not a verdict — "delivered and unconfirmed"
 * is a ceiling on drop-off, because delivery events cannot see inbox placement.
 * Tune it to be useful, not to be small.
 */
import { eq } from "drizzle-orm";
import { tunableThresholds } from "@/lib/db/schema";
import type { Db } from "@/lib/analytics-overview/shared";

export const VERIFICATION_GRACE_KEY = "verification_alert_threshold_hours";

/** Seed and fail-open default. John's constraint 2, verbatim. */
export const DEFAULT_VERIFICATION_GRACE_HOURS = 48;

/** Below this the queue indicts people who just signed up. */
export const VERIFICATION_GRACE_FLOOR_HOURS = 12;

/** Above this a real drop-off problem stays invisible for over a week. */
export const VERIFICATION_GRACE_CEILING_HOURS = 168;

/**
 * Percentile of the observed confirm-delay distribution the window tracks.
 *
 * p95, and the reason is worth recording because p90 was tried first and was
 * wrong. Confirm delays are extremely front-loaded: most people click within
 * minutes, and a real minority take a day or two. At p90 that majority DEFINES
 * the percentile — for a 90/10 split between "two minutes" and "forty hours",
 * p90 is two minutes, the window clamps to the 12h floor, and every one of the
 * slow-but-fine 10% is reported as stuck, every day.
 *
 * p95 sits past where nearly everyone who WILL confirm already has, which is
 * the actual question the window asks. A mean is worse than either — it is
 * dragged toward the fast majority in exactly the same way.
 */
export const VERIFICATION_TUNE_PERCENTILE = 0.95;

/** A threshold is only honoured when it is a finite, positive number. */
function usable(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function clampGraceHours(hours: number): number {
  return Math.min(
    VERIFICATION_GRACE_CEILING_HOURS,
    Math.max(VERIFICATION_GRACE_FLOOR_HOURS, hours)
  );
}

/**
 * The window the queue should use right now.
 *
 * Fails open to the default: an unreadable row degrades to today's intended
 * behaviour, never to "no threshold, so nothing is stuck".
 */
export async function loadVerificationGraceHours(db: Db): Promise<number> {
  try {
    const [row] = await db
      .select({ value: tunableThresholds.value })
      .from(tunableThresholds)
      .where(eq(tunableThresholds.key, VERIFICATION_GRACE_KEY))
      .limit(1);
    const v = usable(row?.value);
    return v === undefined ? DEFAULT_VERIFICATION_GRACE_HOURS : clampGraceHours(v);
  } catch {
    return DEFAULT_VERIFICATION_GRACE_HOURS;
  }
}

/**
 * Constraint 3 — the tuned value for an observed set of confirm delays, in hours.
 *
 * Pure so the policy is testable without a database. Returns `null` when there
 * is not enough evidence to move a live alert threshold: a handful of samples
 * would let one unusual week swing the window across its whole range, which is
 * a worse failure than leaving it where a human put it.
 */
export const VERIFICATION_TUNE_MIN_SAMPLES = 20;

export function computeTunedGraceHours(observedDelayHours: readonly number[]): number | null {
  const clean = observedDelayHours
    .filter((h) => Number.isFinite(h) && h >= 0)
    .sort((a, b) => a - b);
  if (clean.length < VERIFICATION_TUNE_MIN_SAMPLES) return null;

  // Nearest-rank percentile — no interpolation, so the result is always a delay
  // somebody actually experienced.
  const idx = Math.min(
    clean.length - 1,
    Math.ceil(VERIFICATION_TUNE_PERCENTILE * clean.length) - 1
  );
  return clampGraceHours(Math.ceil(clean[idx]));
}
