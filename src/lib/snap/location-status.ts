/**
 * OPE-1549 — the Snap page's always-visible location line.
 *
 * Before this the page gave no hint that it had no location: every upload ever
 * made arrived with `location_source: "none"` and nobody could tell from the
 * screen. Each state now says what is happening and what to do about it.
 */
export type GeoState = "pending" | "ok" | "denied" | "unavailable";

export interface LocationLine {
  text: string;
  tone: "neutral" | "good" | "warn" | "bad";
  /** The line is a button: denied → retry + show how to allow; no fix → open the picker. */
  action: "none" | "retry" | "pick";
}

export function locationLine(input: {
  geo: GeoState;
  accuracyM: number | null;
  /** The event the resolver would match at this fix (atVenue), if any. */
  atEventName: string | null;
  /**
   * OPE-1697 — how many same-day fairs are close enough to be a guess between.
   * More than one, and nothing picked yet → the line asks for a pick instead of
   * claiming "You're at".
   */
  ambiguousCount?: number;
}): LocationLine {
  const acc = input.accuracyM !== null ? ` (±${Math.round(input.accuracyM)} m)` : "";
  switch (input.geo) {
    case "pending":
      return { text: "Locating…", tone: "neutral", action: "none" };
    case "ok":
      if ((input.ambiguousCount ?? 0) > 1) {
        return {
          text: `${input.ambiguousCount} fairs are close by${acc}: pick the one you're at`,
          tone: "warn",
          action: "pick",
        };
      }
      return input.atEventName
        ? { text: `You're at: ${input.atEventName}${acc}`, tone: "good", action: "none" }
        : {
            text: `Located${acc}, but no fair here today: pick the fair`,
            tone: "warn",
            action: "pick",
          };
    case "denied":
      return { text: "Location blocked: tap to fix", tone: "bad", action: "retry" };
    case "unavailable":
      return { text: "No fix: pick the fair", tone: "warn", action: "pick" };
  }
}

/** Shown under the line after a "tap to fix" while location is still blocked. */
export const LOCATION_BLOCKED_HELP =
  "Turn on the phone's Location, then in Chrome: ⋮ → Settings → Site settings → Location → meetmeatthefair.com → Allow. You can still pick the fair by hand below.";
