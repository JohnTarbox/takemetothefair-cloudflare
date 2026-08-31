/**
 * OPE-450 — the acceptance test: replay 2026-08-17 and create nothing.
 *
 * `findPriorAdjudication` shipped on 2026-08-18 in PR #905 with thirteen green
 * tests, and for the thirteen days that followed its ONLY caller was its own
 * test file. Detection was complete and the behaviour was inert. So these tests
 * deliberately do not exercise the detector again — they exercise the WIRE, at
 * the two joints where an inert detector would still look healthy:
 *
 *   1. `submitCheckDuplicate` relays a `prior_adjudication` verdict, and
 *   2. `classifyDedupTier` calls that verdict HIGH — the tier that replies
 *      "already-exists" WITHOUT creating a row.
 *
 * Medium would be the silent wrong answer here: it creates the event, which is
 * precisely the defect. A test asserting only "the field is relayed" would pass
 * with the tier left on medium, and the shell row would be created for a third
 * time while the suite stayed green.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { classifyDedupTier } from "@takemetothefair/utils";
import { submitCheckDuplicate } from "../src/email-handlers/submit.js";

const KEEPER = "defe4089-6065-4d29-bfae-dbd1285c099e";
const SHELL_1 = "38c8371b-b02e-41c9-b8bd-2c6a3e75744b";

const ENV = {
  MAIN_APP_URL: "https://meetmeatthefair.test",
  INTERNAL_API_KEY: "test-key",
} as never;

/** The 2026-08-17 payload, as the extractor produced it from the footer. */
const EXTRACTED = {
  url: "https://click.mlsend.com/link/c/abcdef",
  event: {
    name: "New England Made Autumn Show 2026",
    startDate: "2026-09-15",
    venueCity: "Boxborough",
    venueState: "MA",
  },
} as never;

function mockCheckDuplicate(payload: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }))
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("classifyDedupTier — the disposition that actually suppresses", () => {
  it("calls prior_adjudication HIGH, not medium", () => {
    // HIGH short-circuits before submit-event. MEDIUM creates the row with a
    // `possible_duplicate_of` tag — which is exactly what happened on 08-17,
    // twice. Getting this one string wrong reinstates the whole defect while
    // every other test in this file still passes.
    expect(classifyDedupTier("prior_adjudication")).toBe("high");
  });

  it("did not disturb the existing tiers", () => {
    expect(classifyDedupTier("exact_url")).toBe("high");
    expect(classifyDedupTier("venue_date")).toBe("high");
    expect(classifyDedupTier("series_url")).toBe("medium");
    expect(classifyDedupTier("city_state_date")).toBe("medium");
    expect(classifyDedupTier("similar_name_date")).toBe("medium");
    expect(classifyDedupTier("something-new")).toBe("medium");
  });
});

describe("submitCheckDuplicate — the 2026-08-17 replay", () => {
  it("relays the settled verdict, and it classifies as create-nothing", async () => {
    mockCheckDuplicate({
      success: true,
      isDuplicate: true,
      matchType: "prior_adjudication",
      identifiesSameEvent: true,
      priorAdjudication: {
        rejectedEventId: SHELL_1,
        rejectedEventName: "New England Made Autumn Show 2026",
        basis: "rejected_as_duplicate_of",
      },
      existingEvent: {
        id: KEEPER,
        slug: "new-england-made-giftware-specialty-food-show-autumn",
        name: "New England Made Giftware & Specialty Food Show — Autumn",
        status: "APPROVED",
        sourceUrl: "https://nemadeshows.com/",
      },
    });

    const dup = await submitCheckDuplicate(ENV, EXTRACTED);

    expect(dup.isDuplicate).toBe(true);
    expect(dup.matchType).toBe("prior_adjudication");
    expect(dup.existingEventSlug).toBe("new-england-made-giftware-specialty-food-show-autumn");
    // The ruling this row was settled by, carried through so the workflow's
    // step output can say why nothing was created.
    expect(dup.priorAdjudication?.rejectedEventId).toBe(SHELL_1);
    expect(dup.priorAdjudication?.basis).toBe("rejected_as_duplicate_of");

    // The joint that matters: the relayed verdict must reach the tier that
    // short-circuits before submitEvent. This is the assertion that fails if
    // the detector is wired up but left on medium.
    expect(classifyDedupTier(dup.matchType ?? "")).toBe("high");
  });

  it("carries no adjudication when the endpoint reports none", async () => {
    mockCheckDuplicate({
      success: true,
      isDuplicate: true,
      matchType: "city_state_date",
      existingEvent: { id: "x", slug: "x", name: "X", status: "APPROVED" },
    });

    const dup = await submitCheckDuplicate(ENV, EXTRACTED);
    expect(dup.priorAdjudication).toBeUndefined();
    // Still MEDIUM — an ordinary match must keep creating the row for operator
    // triage. Widening suppression to every match would be the worse failure.
    expect(classifyDedupTier(dup.matchType ?? "")).toBe("medium");
  });

  it("fails OPEN when the dedup endpoint is down", async () => {
    // The pre-existing contract, re-pinned because OPE-450 added a branch to
    // this function: a dedup outage must never start suppressing submissions.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      })
    );
    const dup = await submitCheckDuplicate(ENV, EXTRACTED);
    expect(dup.isDuplicate).toBe(false);
    expect(dup.priorAdjudication).toBeUndefined();
  });
});
