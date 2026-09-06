/**
 * OPE-740 — is this event's date something we were told, or something we made up?
 *
 * ## The copy that is currently false
 *
 * The event card's hedged-date tooltip reads:
 *
 *   > "Dates as submitted — not yet confirmed with the organizer"
 *
 * For a rolled-forward row that is **false in the sender's favour**. Nobody
 * submitted these dates. We generated them by shifting last year's by a
 * weekday. The copy tells a reader an organizer supplied a date we have not
 * checked, when in fact no one supplied it at all — a *stronger* claim than the
 * truth, on 124 indexed pages.
 *
 * TENTATIVE is not a privacy state: those pages render, emit `EventScheduled`,
 * and carry no robots meta. Measured in prod 2026-09-06: 124 rows (121
 * `annual_rollover`, 3 `manual_rollover`, and ZERO `auto_rollover` — the
 * committed writer has never run), all TENTATIVE, all upcoming, starting
 * 2027-02-03 through 2027-10-09. Only 2 carry any date citation; 23 have no
 * citation, no `event_days` and no `source_url` at all.
 *
 * ## Why one predicate, shared
 *
 * There are two cohorts and they are discriminated differently:
 *
 *   - the **121-row one-shot cohort** from an offline `annual_rollover` script
 *     (plus 3 `manual_rollover`), which recorded no lineage — verified in prod:
 *     `rolled_from_event_id` is NULL on every row in the table — so
 *     `ingestion_method` is the only tell;
 *   - anything the **live** path (`event-rollover.ts`, `auto_rollover`) writes,
 *     which sets `rolled_from_event_id` properly and has produced zero rows so
 *     far.
 *
 * A gate keyed on either one alone covers one cohort and silently misses the
 * other. Hence `OR`, in one place both surfaces read.
 *
 * ⚠️ Deliberately NOT keyed on `dates_confirmed`. Two of the 121 carry
 * `dates_confirmed = 1` on a projected date — that flag is the bug, so using it
 * as the discriminator would exempt exactly the two worst rows.
 */

/**
 * Ingestion methods that mean "we projected this date from a prior edition".
 *
 * `annual_rollover` is the offline script's one-shot cohort (121 rows, created
 * 2026-06-13..15). `auto_rollover` is what the committed writer emits.
 * `manual_rollover` is an operator doing the same thing by hand — the date is
 * still a projection, and the reader deserves the same warning.
 */
export const ROLLOVER_INGESTION_METHODS = [
  "annual_rollover",
  "auto_rollover",
  "manual_rollover",
] as const;

export interface DerivedDateInput {
  ingestionMethod?: string | null;
  rolledFromEventId?: string | null;
}

/**
 * Was this event's date projected rather than sourced?
 *
 * Either tell is sufficient — see the note above on the two cohorts.
 */
export function hasDerivedDate(event: DerivedDateInput | null | undefined): boolean {
  if (!event) return false;
  if (event.rolledFromEventId != null && event.rolledFromEventId !== "") return true;
  const m = event.ingestionMethod ?? "";
  return (ROLLOVER_INGESTION_METHODS as readonly string[]).includes(m);
}

/**
 * The short badge word for a projected date.
 *
 * "Projected" rather than "Expected" or "Tentative": both of those describe how
 * confident we are, and the problem is not our confidence — it is that the
 * reader assumes a person told us. This word says where the date came from.
 */
export const DERIVED_DATE_BADGE = "Projected date";

/**
 * The sentence a reader gets.
 *
 * ⚠️ Written to be true rather than reassuring. It states the origin ("from
 * last year's dates"), the gap ("has not published"), and what to do about it.
 * Compare the copy it replaces, which asserted a submission that never happened.
 *
 * ⚠️ This must render as VISIBLE TEXT, not a `title=` attribute. The old copy
 * lived in a tooltip, which means it IS in the served HTML — so a raw-curl grep
 * would pass while no sighted user on a touch device ever saw it. A guard that
 * only greps the response would have called that shipped.
 */
export const DERIVED_DATE_EXPLANATION =
  "We projected these dates from last year's — the organizer has not published them yet.";

/** The same fact, compressed for a card where the full sentence will not fit. */
export const DERIVED_DATE_SHORT = "Projected from last year — not yet published by the organizer";
