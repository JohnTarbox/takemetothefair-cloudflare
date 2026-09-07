/**
 * OPE-847 — linking a crawled roster to its event.
 *
 * This is the only path in the inbound pipeline that creates **public vendor
 * profiles**, and it does so from an unreviewed submission. John approved it
 * in session on 2026-09-07 ("yes, do option (a)"). The guards below are what
 * that approval was given on the strength of, so each is pinned individually
 * and each was driven to failure before shipping.
 */
import { describe, it, expect, vi } from "vitest";
import {
  linkRosterBatch,
  planRosterBatches,
  isLinkableVendorName,
  mergeRosterLinkOutcomes,
  emptyRosterLinkOutcome,
  ROSTER_LINK_MAX,
  ROSTER_LINK_BATCH,
  type CreateOrLinkFn,
} from "../src/email-handlers/roster-link";
import fixture from "../../packages/utils/src/__tests__/fixtures/ope837-mainecheesefestival.json";
import { extractInlineRoster } from "@takemetothefair/utils";

const EVENT = "9d45da16-4c29-4cf4-b419-cf9f3d2be70a";
const SOURCE = "https://mainecheesefestival.org/?page_id=21";

const deps = (createOrLink: CreateOrLinkFn) => ({
  actorUserId: null,
  recomputeVendorCompleteness: vi.fn(async () => undefined),
  logEnrichment: vi.fn(async () => undefined),
  createOrLink,
});

/** A createOrLink stub that records every input it was given. */
function spy(
  behaviour: (name: string, i: number) => unknown = () => ({
    ok: true,
    wasCreated: true,
    wasAlreadyLinked: false,
  })
) {
  const calls: Array<Record<string, unknown>> = [];
  let i = 0;
  const fn = (async (_db, input) => {
    calls.push(input as unknown as Record<string, unknown>);
    return behaviour((input as { businessName: string }).businessName, i++);
  }) as unknown as CreateOrLinkFn;
  return { fn, calls };
}

describe("isLinkableVendorName — the WRITE-boundary gate", () => {
  it("accepts real business names, including ones with legal suffixes", () => {
    for (const n of [
      "27 North",
      "Barters Island Bees, Inc",
      "Dogpatch Farm, LLC",
      "Pinky D's Poutine",
      "Sojourn Ice Co.",
      "The Blue Farmhouse and Seal Cove Cheese",
    ]) {
      expect(`${n}=${isLinkableVendorName(n)}`).toBe(`${n}=true`);
    }
  });

  it("refuses placeholders a roster page legitimately prints", () => {
    // The parser is RIGHT to surface these — the page really does say them.
    // Minting a public vendor called "TBD" is still wrong, which is why this
    // gate is separate from the parser's plausibility check.
    for (const n of ["TBD", "TBA", "and more", "many more", "coming soon", "Various", "N/A"]) {
      expect(`${n}=${isLinkableVendorName(n)}`).toBe(`${n}=false`);
    }
  });

  it("refuses the section heading itself", () => {
    // A cue mis-parse can hand back the heading word.
    for (const n of ["Vendors", "Exhibitors", "Food Trucks", "Sponsors"]) {
      expect(`${n}=${isLinkableVendorName(n)}`).toBe(`${n}=false`);
    }
  });

  it("refuses a single character — caught this in my own test fixture", () => {
    // Not hypothetical: the first draft of this suite used "A"/"B"/"C" as
    // stand-in names and four tests failed, because the gate correctly refused
    // them. Pinned so the length floor is deliberate rather than incidental.
    expect(isLinkableVendorName("A")).toBe(false);
    expect(isLinkableVendorName("Ox")).toBe(true);
  });

  it("refuses URLs, emails, digit-only and sentence-length strings", () => {
    expect(isLinkableVendorName("https://example.org")).toBe(false);
    expect(isLinkableVendorName("director@mainecheeseguild.org")).toBe(false);
    expect(isLinkableVendorName("2026")).toBe(false);
    expect(isLinkableVendorName("&")).toBe(false);
    expect(isLinkableVendorName("a")).toBe(false);
    expect(
      isLinkableVendorName("We are proud to welcome back all of our returning vendors this year")
    ).toBe(false);
  });
});

describe("planRosterBatches — the per-submission cap", () => {
  it("returns no batches for an empty roster, so no step runs at all", () => {
    expect(planRosterBatches([])).toEqual([]);
  });

  it("batches the real 63-name roster", () => {
    const names = ["artisan_21", "cheesemakers_57", "foodtrucks_61"].flatMap((k) =>
      extractInlineRoster((fixture.pages as Record<string, { text: string }>)[k].text)
    );
    expect(names.length).toBe(63);
    const batches = planRosterBatches(names);
    expect(batches.length).toBe(Math.ceil(63 / ROSTER_LINK_BATCH));
    expect(batches.flat()).toHaveLength(63);
    for (const b of batches) expect(b.length).toBeLessThanOrEqual(ROSTER_LINK_BATCH);
  });

  it("caps a pathological roster", () => {
    const many = Array.from({ length: 500 }, (_, i) => `Vendor ${i}`);
    expect(planRosterBatches(many).flat()).toHaveLength(ROSTER_LINK_MAX);
  });
});

describe("linkRosterBatch — what it actually asks createOrLinkVendor for", () => {
  it("ALWAYS passes strict dedup, never fuzzy", async () => {
    // The single most important assertion in this file. OPE-837 records fuzzy
    // as a known duplicate-minter, and a roster is the highest-volume write in
    // the pipeline — the place a bad strategy compounds fastest.
    const s = spy();
    await linkRosterBatch(
      {} as never,
      { eventId: EVENT, names: ["27 North", "Balfour Farm"], sourceUrl: SOURCE },
      deps(s.fn)
    );
    expect(s.calls).toHaveLength(2);
    for (const c of s.calls) expect(c.dedupStrategy).toBe("strict");
    expect(s.calls.some((c) => c.dedupStrategy === "fuzzy")).toBe(false);
  });

  it("uses exactly the field set the operator used by hand", async () => {
    // Prod, event 9d45da16: all 63 rows are
    // CONFIRMED / EXHIBITOR / public_visible=1 / NOT_REQUIRED.
    const s = spy();
    await linkRosterBatch(
      {} as never,
      { eventId: EVENT, names: ["27 North"], sourceUrl: SOURCE },
      deps(s.fn)
    );
    expect(s.calls[0]).toMatchObject({
      eventId: EVENT,
      businessName: "27 North",
      status: "CONFIRMED",
      participationType: "EXHIBITOR",
      paymentStatus: "NOT_REQUIRED",
      publicVisible: true,
    });
  });

  it("counts created / linked / already-linked separately", async () => {
    const s = spy((name) => {
      if (name === "Alpha Farm") return { ok: true, wasCreated: true, wasAlreadyLinked: false };
      if (name === "Beta Farm") return { ok: true, wasCreated: false, wasAlreadyLinked: false };
      return { ok: true, wasCreated: false, wasAlreadyLinked: true };
    });
    const out = await linkRosterBatch(
      {} as never,
      { eventId: EVENT, names: ["Alpha Farm", "Beta Farm", "Gamma Farm"], sourceUrl: SOURCE },
      deps(s.fn)
    );
    expect(out).toMatchObject({ created: 1, linked: 1, alreadyLinked: 1, failed: 0, rejected: 0 });
  });

  it("never writes a name the gate refused", async () => {
    const s = spy();
    const out = await linkRosterBatch(
      {} as never,
      { eventId: EVENT, names: ["27 North", "TBD", "and more", "Balfour Farm"], sourceUrl: SOURCE },
      deps(s.fn)
    );
    expect(out.rejected).toBe(2);
    expect(s.calls.map((c) => c.businessName)).toEqual(["27 North", "Balfour Farm"]);
  });
});

describe("isolation — one bad name must not cost the rest, or the submission", () => {
  it("continues past a thrown error and counts it", async () => {
    const s = spy((name) => {
      if (name === "Beta Farm") throw new Error("boom");
      return { ok: true, wasCreated: true, wasAlreadyLinked: false };
    });
    const out = await linkRosterBatch(
      {} as never,
      { eventId: EVENT, names: ["Alpha Farm", "Beta Farm", "Gamma Farm"], sourceUrl: SOURCE },
      deps(s.fn)
    );
    expect(out.created).toBe(2);
    expect(out.failed).toBe(1);
    expect(out.failures[0]).toMatchObject({ name: "Beta Farm", error: "boom" });
  });

  it("continues past an ok:false result", async () => {
    const s = spy((name) =>
      name === "Beta Farm"
        ? { ok: false, error: "Event not found" }
        : { ok: true, wasCreated: true }
    );
    const out = await linkRosterBatch(
      {} as never,
      { eventId: EVENT, names: ["Alpha Farm", "Beta Farm", "Gamma Farm"], sourceUrl: SOURCE },
      deps(s.fn)
    );
    expect(out.created).toBe(2);
    expect(out.failed).toBe(1);
  });

  it("never throws, even when every single name fails", async () => {
    const s = spy(() => {
      throw new Error("total outage");
    });
    const out = await linkRosterBatch(
      {} as never,
      { eventId: EVENT, names: ["Alpha Farm", "Beta Farm"], sourceUrl: SOURCE },
      deps(s.fn)
    );
    expect(out.failed).toBe(2);
    expect(out.created).toBe(0);
  });

  it("bounds the failure sample on the ok:false branch too", async () => {
    // Both failure branches keep their own bound, and a mutation pass showed
    // the two are independently reachable: mutating the ok:false bound left
    // the throwing test green, because that test exercises the catch branch.
    // Two branches, two tests.
    const s = spy(() => ({ ok: false, error: "Event not found" }));
    const out = await linkRosterBatch(
      {} as never,
      {
        eventId: EVENT,
        names: Array.from({ length: 40 }, (_, i) => `Vendor Number ${i}`),
        sourceUrl: SOURCE,
      },
      deps(s.fn)
    );
    expect(out.failed).toBe(40);
    expect(out.failures).toHaveLength(10);
  });

  it("bounds the failure sample so a bad page cannot bloat the step record", async () => {
    const s = spy(() => {
      throw new Error("nope");
    });
    const out = await linkRosterBatch(
      {} as never,
      {
        eventId: EVENT,
        names: Array.from({ length: 40 }, (_, i) => `Vendor ${i}`),
        sourceUrl: SOURCE,
      },
      deps(s.fn)
    );
    expect(out.failed).toBe(40);
    expect(out.failures).toHaveLength(10);
  });
});

describe("mergeRosterLinkOutcomes", () => {
  it("sums across batches and keeps the sample bounded", () => {
    const a = {
      ...emptyRosterLinkOutcome(),
      created: 2,
      failed: 1,
      failures: [{ name: "x", error: "e" }],
    };
    const b = { ...emptyRosterLinkOutcome(), created: 3, alreadyLinked: 4 };
    expect(mergeRosterLinkOutcomes(a, b)).toMatchObject({
      created: 5,
      alreadyLinked: 4,
      failed: 1,
    });
  });
});

describe("the specimen, end to end through the gate", () => {
  it("links all 63 real names — none is refused by the write gate", async () => {
    const names = ["artisan_21", "cheesemakers_57", "foodtrucks_61"].flatMap((k) =>
      extractInlineRoster((fixture.pages as Record<string, { text: string }>)[k].text)
    );
    const s = spy();
    let out = emptyRosterLinkOutcome();
    for (const batch of planRosterBatches(names)) {
      out = mergeRosterLinkOutcomes(
        out,
        await linkRosterBatch(
          {} as never,
          { eventId: EVENT, names: batch, sourceUrl: SOURCE },
          deps(s.fn)
        )
      );
    }
    // The acceptance number, and a positive landmark: 63 examined, 0 rejected.
    expect(out.created + out.linked + out.alreadyLinked).toBe(63);
    expect(out.rejected).toBe(0);
    expect(out.failed).toBe(0);
    expect(s.calls).toHaveLength(63);
  });
});
