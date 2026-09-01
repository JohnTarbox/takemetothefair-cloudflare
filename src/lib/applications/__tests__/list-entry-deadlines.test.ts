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
