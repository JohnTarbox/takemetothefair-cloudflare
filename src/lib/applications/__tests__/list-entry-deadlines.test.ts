/**
 * OPE-738 — acceptance tests for the cross-event entry-deadline index.
 *
 * Two of this ticket's acceptance criteria are explicitly "prove it by test,
 * not by inspection", and both describe a failure that LOOKS like success:
 *
 *  - a dropped NULL-`closes_at` group renders as an empty section, which is
 *    indistinguishable from "no such rows exist";
 *  - an ordering bug that sorts by the fair's `start_date` gives a plausible
 *    list that is simply answering a different question.
 *
 * So every fixture below is built so that the WRONG implementation produces a
 * different, checkable answer — the deadlines are deliberately in the opposite
 * order to the fairs they belong to.
 */
import { describe, it, expect } from "vitest";
import {
  bucketEntryDeadline,
  groupEntryDeadlines,
  statesPresent,
  type EntryDeadlineRow,
} from "@/lib/applications/list-entry-deadlines";

const NOW = new Date("2026-09-01T12:00:00.000Z");
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

function row(over: Partial<EntryDeadlineRow> & { id: string }): EntryDeadlineRow {
  return {
    department: null,
    url: null,
    contactEmail: null,
    notes: null,
    closesAt: null,
    eventSlug: `slug-${over.id}`,
    eventName: `Fair ${over.id}`,
    eventStartDate: null,
    venueState: "ME",
    venueCity: "Augusta",
    ...over,
  };
}

describe("bucketEntryDeadline", () => {
  it("puts a NULL closes_at in `undated` — never drops it", () => {
    expect(bucketEntryDeadline(null, NOW)).toBe("undated");
  });

  it("keeps an undated row regardless of how narrow the windows are", () => {
    // The windows must not be able to reach a NULL row at all. A `closes_at`
    // of NULL is "not published", not "closed long ago".
    expect(bucketEntryDeadline(null, NOW, { recentlyClosedDays: 0, forwardWindowDays: 0 })).toBe(
      "undated"
    );
  });

  it("classifies a future deadline inside the horizon as open", () => {
    expect(bucketEntryDeadline(days(10), NOW)).toBe("open");
  });

  it("classifies a just-passed deadline as recently_closed, not dropped", () => {
    expect(bucketEntryDeadline(days(-3), NOW)).toBe("recently_closed");
  });

  it("drops a deadline that closed before the lookback window", () => {
    expect(bucketEntryDeadline(days(-31), NOW)).toBeNull();
  });

  it("drops a deadline beyond the forward horizon", () => {
    expect(bucketEntryDeadline(days(366), NOW)).toBeNull();
  });
});

/**
 * OPE-750 — the open/closed boundary is the deadline's CALENDAR DAY in
 * `VENUE_TZ`, not the stored instant.
 *
 * `event_applications.closes_at` carried three encodings of a closing date at
 * once (23:59:59 ET ×74, noon UTC ×8, 23:59:59 UTC ×1), because drizzle/0257
 * backfilled the noon-anchored `events.application_deadline` straight into it.
 * drizzle/0258 re-anchored the nine strays, but the reader must survive a
 * fourth convention: there is no code write path to this table at all, so rows
 * arrive by hand.
 *
 * Every case below is anchored on a REAL production row — Topsfield Fair
 * 2026's Draft Horse entries, `closes_at = 1788580799` — so the fixtures cannot
 * drift into describing a shape the data never had.
 */
describe("bucketEntryDeadline — ET calendar-day boundary (OPE-750)", () => {
  /** Topsfield Draft Horse: 1788580799 = 2026-09-05 03:59:59Z = Fri 2026-09-04 23:59:59 EDT. */
  const TOPSFIELD_CLOSES = new Date(1_788_580_799 * 1000);
  /** The same closing DATE encoded the way drizzle/0257's backfill produced: noon UTC = 08:00 ET. */
  const NOON_ANCHORED_SAME_DAY = new Date(Date.UTC(2026, 8, 4, 12, 0, 0));

  const etNoonOn = (day: number) => new Date(Date.UTC(2026, 8, day, 16, 0, 0)); // 12:00 EDT

  // ── DISCRIMINATORS ──────────────────────────────────────────────────────
  // Verified by mutation: reverting the boundary to `delta >= 0` fails exactly
  // these two and no others. The remaining cases in this block are LANDMARKS —
  // they pass under both implementations by design, and exist so that a
  // degenerate "never closes anything" version cannot satisfy the two above.

  it("DISCRIMINATOR: holds a noon-anchored deadline OPEN through its own Eastern afternoon", () => {
    // The regression. Under the old `closesAt.getTime() >= now.getTime()` this
    // is "recently_closed" from 08:00 ET — a visitor is told they have missed
    // an entry that is open for another sixteen hours.
    expect(bucketEntryDeadline(NOON_ANCHORED_SAME_DAY, etNoonOn(4))).toBe("open");
  });

  it("DISCRIMINATOR: holds the lone 23:59:59-UTC row open through its Eastern evening", () => {
    // The third convention, from the real row: Maker Battle 2026 - Round 1,
    // `closes_at = 1778889599` = 2026-05-15 23:59:59Z = 19:59:59 EDT. Between
    // 20:00 and midnight Eastern the instant test says closed and the calendar
    // day says open — four more hours in which entries are genuinely accepted.
    const makerBattle = new Date(1_778_889_599 * 1000);
    const ninePmEtMay15 = new Date(Date.UTC(2026, 4, 16, 1, 0, 0)); // 21:00 EDT May 15
    expect(bucketEntryDeadline(makerBattle, ninePmEtMay15)).toBe("open");
  });

  it("closes that same noon-anchored deadline once its Eastern day is over", () => {
    // The positive landmark for the assertion above. Without it, an
    // implementation that simply never closes anything passes the first test.
    expect(bucketEntryDeadline(NOON_ANCHORED_SAME_DAY, etNoonOn(5))).toBe("recently_closed");
  });

  it("keeps the real Topsfield row open at 23:00 ET on its closing night", () => {
    const elevenPmEt = new Date(Date.UTC(2026, 8, 5, 3, 0, 0)); // 23:00 EDT Sep 4
    expect(bucketEntryDeadline(TOPSFIELD_CLOSES, elevenPmEt)).toBe("open");
  });

  it("closes the real Topsfield row after midnight ET, not after midnight UTC", () => {
    // 2026-09-05 01:00Z is 21:00 EDT on Sep 4 — still Sep 4 in Eastern, so a
    // UTC-day implementation would already call this closed. It must not.
    const ninePmEt = new Date(Date.UTC(2026, 8, 5, 1, 0, 0));
    expect(bucketEntryDeadline(TOPSFIELD_CLOSES, ninePmEt)).toBe("open");

    const oneAmEtNextDay = new Date(Date.UTC(2026, 8, 5, 5, 0, 0)); // 01:00 EDT Sep 5
    expect(bucketEntryDeadline(TOPSFIELD_CLOSES, oneAmEtNextDay)).toBe("recently_closed");
  });

  it("still measures DISTANCE with the raw instant — only the boundary moved", () => {
    // The lookback window is a duration question and was never ambiguous.
    // A deadline 31 days past its Eastern day is still dropped entirely.
    const longPast = new Date(TOPSFIELD_CLOSES.getTime() - 0);
    const wayLater = new Date(TOPSFIELD_CLOSES.getTime() + 31 * 86_400_000);
    expect(bucketEntryDeadline(longPast, wayLater)).toBeNull();
  });
});

describe("groupEntryDeadlines", () => {
  it("orders open deadlines by closes_at, NOT by the fair's start_date", () => {
    // The fixture is the point: the fair that starts FIRST has the LAST
    // deadline. Sorting by start_date yields ["early-fair", "late-fair"];
    // sorting correctly by closes_at yields the reverse.
    const rows = [
      row({
        id: "early-fair",
        closesAt: days(40),
        eventStartDate: days(5),
        eventName: "Early Fair",
      }),
      row({
        id: "late-fair",
        closesAt: days(10),
        eventStartDate: days(90),
        eventName: "Late Fair",
      }),
    ];

    const { open } = groupEntryDeadlines(rows, NOW);

    expect(open.map((r) => r.id)).toEqual(["late-fair", "early-fair"]);
  });

  it("keeps undated rows present and in their own group, alongside dated ones", () => {
    const rows = [
      row({ id: "dated", closesAt: days(7) }),
      row({ id: "undated-a", closesAt: null, eventName: "Zebra Fair" }),
      row({ id: "undated-b", closesAt: null, eventName: "Apple Fair" }),
    ];

    const grouped = groupEntryDeadlines(rows, NOW);

    // The whole point of the criterion: the undated rows survive, and they are
    // reachable as their own set rather than mixed in with dated ones.
    expect(grouped.undated.map((r) => r.id)).toEqual(["undated-b", "undated-a"]);
    expect(grouped.open.map((r) => r.id)).toEqual(["dated"]);
    expect(grouped.recentlyClosed).toEqual([]);
  });

  it("does not lose a single input row that falls inside the windows", () => {
    const rows = [
      row({ id: "open", closesAt: days(3) }),
      row({ id: "closed", closesAt: days(-2) }),
      row({ id: "undated", closesAt: null }),
    ];

    const grouped = groupEntryDeadlines(rows, NOW);
    const total = grouped.open.length + grouped.recentlyClosed.length + grouped.undated.length;

    expect(total).toBe(rows.length);
  });

  it("sorts recently-closed most-recent-first", () => {
    const rows = [
      row({ id: "older", closesAt: days(-20) }),
      row({ id: "newer", closesAt: days(-1) }),
    ];

    expect(groupEntryDeadlines(rows, NOW).recentlyClosed.map((r) => r.id)).toEqual([
      "newer",
      "older",
    ]);
  });

  it("keeps an undated row for a fair whose own dates are long past", () => {
    // A forward gate drawn on the EVENT would remove this row. The deadline is
    // the subject of this page, not the fair — see FORWARD_WINDOW_DAYS.
    const rows = [row({ id: "old-fair", closesAt: null, eventStartDate: days(-400) })];

    expect(groupEntryDeadlines(rows, NOW).undated.map((r) => r.id)).toEqual(["old-fair"]);
  });
});

describe("statesPresent", () => {
  it("returns distinct sorted states and ignores rows with no venue", () => {
    const rows = [
      row({ id: "1", venueState: "VT" }),
      row({ id: "2", venueState: "ME" }),
      row({ id: "3", venueState: "VT" }),
      row({ id: "4", venueState: null }),
    ];

    expect(statesPresent(rows)).toEqual(["ME", "VT"]);
  });
});
