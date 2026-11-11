/**
 * OPE-1613 — contradictions inside ONE feed item: its own fields against its
 * own text. Moved here from `mcp-server/src/feeds/ingest.ts` (OPE-1625) so the
 * feed ingest and the main app's test-submission engine flag the same things
 * with the same words; ingest.ts imports it from here. Pure.
 */
import type { FeedEvent } from "./feed-event";

export interface SelfContradiction {
  field: "start_time" | "venue" | "status";
  kind: "am_pm_slip" | "state_only_location" | "cancelled_in_text";
  ourValue: null;
  feedValue: string | null;
  /** The value the item's own text implies, when it implies one. */
  hint: string | null;
  /** One line the contact can answer at a glance. */
  question: string;
  /** One line naming where the feed is wrong, for their web person. */
  feedFixNote: string;
}

/** "16:30" → "4:30 PM". */
export const to12h = (hhmm: string): string => {
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
};

/**
 * Contradictions inside ONE feed item — its own fields against its own text.
 * Each finding names the evidence, so the question can quote it.
 */
export function detectSelfContradictions(ev: FeedEvent): SelfContradiction[] {
  const out: SelfContradiction[] = [];
  const when = `${ev.title}${ev.startDate ? `, ${ev.startDate}` : ""}`;
  // 1. An early-morning start whose own description states the same clock time PM.
  if (ev.startTime) {
    const [h, m] = ev.startTime.split(":").map(Number);
    if (h >= 0 && h < 7) {
      const h12 = h === 0 ? 12 : h;
      const re = new RegExp(`\\b${h12}(?::${String(m).padStart(2, "0")})?\\s*p\\.?\\s*m\\b`, "i");
      // OPE-1617 — OHTM writes ranges: "runs 4:30-6:30 PM". The PM there belongs
      // to both ends, so a 04:30 start against that text is the same slip.
      const range = new RegExp(
        `\\b${h12}(?::${String(m).padStart(2, "0")})?\\s*(?:-|–|—|to)\\s*\\d{1,2}(?::\\d{2})?\\s*p\\.?\\s*m\\b`,
        "i"
      );
      if (
        re.test(ev.description) ||
        range.test(ev.description) ||
        (m === 0 && new RegExp(`\\b${h12}\\s*p\\.?m\\b`, "i").test(ev.description))
      ) {
        const hint = `${String(h + 12).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
        out.push({
          field: "start_time",
          kind: "am_pm_slip",
          ourValue: null,
          feedValue: ev.startTime,
          hint,
          question: `${when}: your feed says ${to12h(ev.startTime)}, the description says ${to12h(hint)}. Which is right?`,
          feedFixNote: `The calendar entry's start time is set to ${to12h(ev.startTime)} (AM); the description says PM.`,
        });
      }
    }
  }
  // 2. A location that is only a state code.
  const v = ev.venue;
  if (v && !v.name && !v.address && !v.city && v.state && /^[A-Za-z]{2}$/.test(v.state)) {
    out.push({
      field: "venue",
      kind: "state_only_location",
      ourValue: null,
      feedValue: v.state,
      hint: null,
      question: `${when}: your feed gives the location only as "${v.state}". Where is it held?`,
      feedFixNote: `The calendar entry's venue has no name or address, only "${v.state}".`,
    });
  } else if (v?.name && /^[A-Za-z]{2}$/.test(v.name) && !v.address && !v.city) {
    out.push({
      field: "venue",
      kind: "state_only_location",
      ourValue: null,
      feedValue: v.name,
      hint: null,
      question: `${when}: your feed gives the location only as "${v.name}". Where is it held?`,
      feedFixNote: `The calendar entry's venue is just "${v.name}".`,
    });
  }
  // 3. The text says cancelled; the feed's own status does not.
  if (!ev.statusCancelled && /\bcancel+ed\b/i.test(`${ev.title}\n${ev.description}`)) {
    out.push({
      field: "status",
      kind: "cancelled_in_text",
      ourValue: null,
      feedValue: "scheduled",
      hint: "cancelled",
      question: `${when}: the listing's text says it is cancelled, but the calendar still lists it. Is it still happening?`,
      feedFixNote: `The entry is still published as scheduled although its text says cancelled.`,
    });
  }
  return out;
}
