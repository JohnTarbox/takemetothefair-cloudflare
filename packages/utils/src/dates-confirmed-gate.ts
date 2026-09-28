/**
 * OPE-1200 — `events.dates_confirmed = 1` requires a live, non-aggregator
 * citation for the start date.
 *
 * OPE-433 diagnosed the flag as a free-floating boolean: nothing checked it
 * against `event_data_citations`, and 64% of upcoming confirmed rows (312 of
 * 489, prod 2026-09-28) carried no active start_date citation. The user-facing
 * cost arrived that day — four public listings sent visitors to the wrong day or
 * the wrong STATE while claiming confirmed dates (an Oregon show on a Maine
 * venue, a Tanger fair a week early, a show that did not exist).
 *
 * The rule, applied at every writer that can set the flag TRUE:
 *   TRUE is kept only when the event already has a QUALIFYING citation, or the
 *   caller passes one in the same call. Otherwise FALSE is written and the
 *   caller gets a warning saying why.
 *
 * A citation QUALIFIES when it is an `active` start_date citation whose source
 * is neither a community submission (`source_type = 'user_submitted'`) nor an
 * aggregator host (the same AGGREGATOR_HOSTS list `classifySource` uses — the
 * Tanger row's lakesregion.org source is exactly this case).
 *
 * Pure: callers load the citations; this decides. That keeps the one rule
 * shared by the main app and the MCP Worker, which write the same column.
 */
import { classifySource } from "./source-classification";

export interface DateCitationLike {
  fieldName: string;
  state: string | null;
  sourceType: string | null;
  sourceUrl: string | null;
}

/** A source offered in the same call (e.g. `update_event`'s `citation` arg). */
export interface CallDateSource {
  sourceType?: string | null;
  sourceUrl?: string | null;
}

/** Why a citation or call source does not qualify, or null when it does. */
export function dateSourceDisqualifier(src: {
  sourceType?: string | null;
  sourceUrl?: string | null;
}): "no_source_url" | "community_submission" | "aggregator" | null {
  const url = src.sourceUrl?.trim();
  if (!url) return "no_source_url";
  if (src.sourceType === "user_submitted") return "community_submission";
  if (classifySource(null, url).ingestionMethod === "aggregator_import") return "aggregator";
  return null;
}

/** OPE-1205 — exported for its second caller, the sync-staleness sweep. */
export function isQualifyingDateCitation(c: DateCitationLike): boolean {
  return (
    c.fieldName === "start_date" &&
    c.state === "active" &&
    dateSourceDisqualifier({ sourceType: c.sourceType, sourceUrl: c.sourceUrl }) === null
  );
}

export interface DatesConfirmedGateResult {
  /** The value to write. */
  value: boolean;
  /** True when the caller asked for TRUE and the gate wrote FALSE. */
  downgraded: boolean;
  /** Present exactly when `downgraded`; safe to show the caller verbatim. */
  warning?: string;
}

export function gateDatesConfirmed(args: {
  requested: boolean;
  /** The event's existing citations (any field/state — filtered here). An
   *  insert has none. */
  citations: readonly DateCitationLike[];
  /** A source the caller supplied alongside this write, if any. */
  callSource?: CallDateSource | null;
}): DatesConfirmedGateResult {
  if (!args.requested) return { value: false, downgraded: false };
  if (args.citations.some(isQualifyingDateCitation)) return { value: true, downgraded: false };
  if (args.callSource && dateSourceDisqualifier(args.callSource) === null) {
    return { value: true, downgraded: false };
  }

  const why = args.callSource ? dateSourceDisqualifier(args.callSource) : null;
  const reason =
    why === "aggregator"
      ? "the source supplied is an aggregator, not the organizer"
      : why === "community_submission"
        ? "the source supplied is a community submission"
        : "there is no active start_date citation from an organizer or primary source";
  return {
    value: false,
    downgraded: true,
    warning:
      `dates_confirmed was written as false: ${reason}. ` +
      "Add a start_date citation (update_event `citation`, or create_event_citation) " +
      "from the organizer's own page, then set dates_confirmed again.",
  };
}
