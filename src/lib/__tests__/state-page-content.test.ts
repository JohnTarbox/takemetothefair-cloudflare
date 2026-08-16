/**
 * OPE-394 — the state-page editorial + FAQ layer.
 *
 * The ticket's binding constraint is "grounded / no fabricated hours". So most
 * of what matters here is what the module REFUSES to say when the data cannot
 * support it — a confident sentence about a real place, generated from thin
 * data, is the failure mode these tests exist to prevent.
 */
import { describe, it, expect } from "vitest";
import {
  buildStateIntro,
  buildStateFaq,
  peakSeason,
  busiestMonth,
  STATE_FAQ_MIN_ITEMS,
  type StateInventory,
} from "@/lib/state-page-content";

/** A plausible New England season: summer-weighted, ~120 events. */
const SUMMER: number[] = [2, 2, 3, 5, 9, 20, 26, 24, 16, 8, 3, 2];

function inv(over: Partial<StateInventory> = {}): StateInventory {
  return {
    upcomingCount: 120,
    countsByMonth: SUMMER,
    topCategories: ["Agricultural Fair", "Craft Show", "Festival", "Farmers Market"],
    townCount: 47,
    ...over,
  };
}

describe("peakSeason", () => {
  it("finds the contiguous span carrying the bulk of the calendar", () => {
    const s = peakSeason(SUMMER);
    expect(s).not.toBeNull();
    expect(s!.from).toBe("June");
    expect(s!.to).toBe("September");
  });

  it("returns null on thin data rather than inventing a season", () => {
    // "Fair season runs June to September" is a factual claim about a real
    // place. From 5 events it is a guess wearing a fact's clothes.
    expect(peakSeason([1, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0])).toBeNull();
    expect(peakSeason(new Array(12).fill(0))).toBeNull();
  });

  it("returns null when events are spread across the whole year", () => {
    // A span covering ten or more months is not a season, and calling it one
    // would be technically true and practically misleading.
    expect(peakSeason(new Array(12).fill(10))).toBeNull();
  });
});

describe("busiestMonth", () => {
  it("names the peak month", () => {
    expect(busiestMonth(SUMMER)).toBe("July");
  });

  it("stays silent on thin data", () => {
    expect(busiestMonth([1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBeNull();
  });
});

describe("buildStateIntro", () => {
  it("states the count, the town spread and the season when all are known", () => {
    const text = buildStateIntro("Massachusetts", inv(), 2026);
    expect(text).toContain("120 upcoming Massachusetts fairs");
    expect(text).toContain("47 towns");
    expect(text).toContain("between June and September");
  });

  it("drops the season sentence rather than softening it when data is thin", () => {
    const text = buildStateIntro(
      "Vermont",
      inv({ upcomingCount: 3, countsByMonth: [0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0], townCount: 2 }),
      2026
    );
    expect(text).not.toContain("between");
    expect(text).not.toMatch(/season/i);
    // Still says something true.
    expect(text).toContain("Vermont");
  });

  it("does not claim a count when there are no upcoming events", () => {
    const text = buildStateIntro(
      "Rhode Island",
      inv({ upcomingCount: 0, countsByMonth: new Array(12).fill(0), townCount: 0 }),
      2026
    );
    expect(text).not.toContain("0 upcoming");
    expect(text).toContain("year-round");
  });

  it("never asserts hours, prices or admission", () => {
    // The grounding rule, as an assertion. These are the specifics that get
    // fabricated in generated SEO copy, and none of them are derivable here.
    const text = buildStateIntro("Connecticut", inv(), 2026);
    expect(text).not.toMatch(/\b(am|pm|free admission|\$\d)/i);
  });
});

describe("buildStateFaq", () => {
  it("produces a full, grounded FAQ for a well-populated state", () => {
    const faq = buildStateFaq("Massachusetts", inv(), 2026);
    expect(faq.length).toBeGreaterThanOrEqual(STATE_FAQ_MIN_ITEMS);
    expect(faq[0].question).toContain("Massachusetts");
    expect(faq[0].answer).toContain("120");
    expect(faq.some((f) => /fair season/i.test(f.question))).toBe(true);
  });

  it("falls BELOW the emit floor for a state with almost no data", () => {
    // The caller suppresses both the block and the JSON-LD below the floor.
    // Padding to reach three would be exactly the thin-page risk the epic
    // names as its own guardrail.
    const faq = buildStateFaq(
      "Vermont",
      inv({
        upcomingCount: 0,
        countsByMonth: new Array(12).fill(0),
        topCategories: [],
        townCount: 0,
      }),
      2026
    );
    expect(faq.length).toBeLessThan(STATE_FAQ_MIN_ITEMS);
  });

  it("omits the category question when there is only one category", () => {
    const faq = buildStateFaq("Maine", inv({ topCategories: ["Agricultural Fair"] }), 2026);
    expect(faq.some((f) => /kinds of events/i.test(f.question))).toBe(false);
  });

  it("every answer is non-empty and mentions the state", () => {
    const faq = buildStateFaq("Connecticut", inv(), 2026);
    for (const item of faq) {
      expect(item.answer.trim().length).toBeGreaterThan(20);
      expect(item.question.trim().length).toBeGreaterThan(10);
    }
    expect(faq.every((f) => f.question.includes("Connecticut"))).toBe(true);
  });

  it("rolls the year rather than hard-coding it", () => {
    const a = buildStateFaq("Maine", inv(), 2026)[0].answer;
    const b = buildStateFaq("Maine", inv(), 2027)[0].answer;
    expect(a).toContain("2026");
    expect(b).toContain("2027");
  });
});
