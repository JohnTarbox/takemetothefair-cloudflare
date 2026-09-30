/**
 * OPE-463 — the reject reason codes, typed as `family_id` rather than free text.
 *
 * Lives in `@takemetothefair/constants` because BOTH Workers need it: the MCP
 * Worker enforces the gate on `update_event_status`, and the main app reads the
 * same vocabulary when emitting the fault. A copy in each would be the
 * split-construction defect OPE-806 just finished closing.
 *
 * ## Why an enum and not a comment box
 *
 * A human rejecting an auto-created event is making the highest-quality
 * judgement this system ever receives about what the extractor got wrong, and
 * every one has been discarded: measured 2026-09-06, **`lifecycle_reason` is
 * NULL on all 36 REJECTED `email_submission` events** — up from the 24 recorded
 * on 2026-08-18, so the loss has been accruing the whole time.
 *
 * Typing the enum as `family_id` values (rather than prose) is what makes CPI
 * stage 2 — Tier-0 classify — resolve with no mapping layer in between. The
 * enum IS the family registry.
 *
 * ## Why this is the emitter that works on day one
 *
 * The other two emitters OPE-463 specifies need a model:
 * `extract.unsupported_field` waits on the G5 grounding verifier (OPE-465) and
 * `extract.fanout` on the reconciliation stage (OPE-378). This one needs
 * nothing but a required field on a path an operator already walks.
 *
 * ⚠️ Every value below has a real logged instance behind it. They are not a
 * taxonomy invented at a whiteboard, and a value should not be added without
 * one — an enum whose options outrun its evidence trains operators to pick
 * whatever is nearest.
 */

export const EXTRACTION_REJECT_FAMILIES = [
  /** One event written as N rows. OPE-378, OPE-432, and the UMF specimen. */
  "over-split",
  /** N events written as one. OPE-459 defect 3. */
  "over-collapse",
  /**
   * A value no source asserts — the fabricated `2026-11-01 → 2026-11-30` span,
   * MDI's invented hours, the 09:00–18:00 `event_days`. F-14 candidate.
   */
  "fabricated-field",
  /**
   * An event written from a mention of a FUTURE announcement. The two "UMF
   * December Craft Fair" rows came from a sentence saying the December details
   * would be sent later.
   */
  "phantom-event",
  /** A citation naming a source that does not contain the claim. OPE-457. */
  "false-attribution",
  /** The submission's content never reached the extractor. OPE-452. */
  "capture-loss",
  /** Newsletter footer, vendor roster, solicitation. OPE-450 scope 4, OPE-278. */
  "not-an-event",
  /**
   * Already covered by `rejected_as_duplicate_of` (OPE-450).
   *
   * ⚠️ Kept in the enum so the two stay in sync rather than describing the same
   * adjudication two different ways. When this value is chosen the caller
   * SHOULD also set `rejected_as_duplicate_of`; the reject path fills it from
   * `possible_duplicate_of` automatically when that is set.
   */
  "duplicate-of-existing",
] as const;

export type ExtractionRejectFamily = (typeof EXTRACTION_REJECT_FAMILIES)[number];

// ⚠️ No `isExtractionRejectFamily` type guard here, deliberately.
//
// I wrote one and OPE-726's inert-detector check caught it with no production
// caller — correctly. The only boundary that needs validation is the MCP tool,
// and `z.enum(EXTRACTION_REJECT_FAMILIES)` already does it there. A hand-rolled
// predicate alongside would be a second answer to a question zod has already
// answered, and the first one to drift would be the one nothing calls.
//
// If a non-zod boundary ever needs it, add it THEN, with that caller.

/**
 * Which ingestion methods must supply a reason on REJECT.
 *
 * ⚠️ Deliberately NOT every event. A human rejecting a hand-entered admin row
 * is not labelling an extractor — there is no extractor in that path — so
 * demanding a family from them would collect noise and train the requirement
 * into a nuisance. The requirement is only meaningful where a machine wrote the
 * row and the reject is therefore a verdict on that machine.
 */
export const REASON_REQUIRED_INGESTION_METHODS = ["email_submission"] as const;

export function rejectReasonRequired(ingestionMethod: string | null | undefined): boolean {
  return (REASON_REQUIRED_INGESTION_METHODS as readonly string[]).includes(ingestionMethod ?? "");
}

/**
 * The signature for a human-reject fault.
 *
 * Keyed on the family alone, NOT on the event. Faults dedup by recurrence —
 * "the extractor over-splits" is one fault seen N times, not N faults. Keying
 * on the event id would make every reject a new signature, `count` would never
 * exceed 1, and the recurrence threshold the rail files on could never be met.
 */
export function humanRejectSignature(family: ExtractionRejectFamily, source: string): string {
  return `extract.human_reject:${source}:${family}`;
}
