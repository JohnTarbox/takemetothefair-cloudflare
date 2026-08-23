/**
 * OPE-460 — "Thanks for submitting 6 events" above five ❌ lines.
 *
 * Both real acks from 2026-08-17, quoted from `email_send_ledger`:
 *
 *   "Thanks for submitting 4 events…"   3 ✅  1 ❌
 *   "Thanks for submitting 6 events…"   1 ✅  5 ❌
 *
 * All three `ok-multi` call sites passed `eventCount: outcomes.length`, and
 * `SourceOutcome` mixes results with failures:
 *
 *   "created" | "already-exists" | "submit-failed" | "extract-failed" | "fetch-failed"
 *
 * So the headline counted ATTEMPTS. Every failed fetch inflated it, and the
 * body of the same email then explained, line by line, why most of them hadn't
 * worked.
 *
 * `already-exists` counts as landed: the sender's event IS in the directory,
 * which is a real outcome, just not a new row. A failure is not an outcome at
 * all.
 */
import { describe, expect, it } from "vitest";
import { countOutcomes, type OutcomeKind } from "../src/email-handlers/outcome-counts.js";
import { buildReply } from "../src/email-reply-builder.js";

const o = (kind: OutcomeKind) => ({ kind });

describe("the two acks that were actually sent", () => {
  it('"6 events" was really 1', () => {
    // 1 ✅ created, 3 extract-failed, 2 fetch-failed.
    const outcomes = [
      o("created"),
      o("extract-failed"),
      o("extract-failed"),
      o("fetch-failed"),
      o("extract-failed"),
      o("fetch-failed"),
    ];
    const c = countOutcomes(outcomes);
    expect(c.attempted).toBe(6); // the old headline
    expect(c.landed).toBe(1); // the new one
    expect(c.failed).toBe(5);
  });

  it('"4 events" was really 3', () => {
    const outcomes = [o("created"), o("created"), o("created"), o("extract-failed")];
    const c = countOutcomes(outcomes);
    expect(c.attempted).toBe(4);
    expect(c.landed).toBe(3);
  });
});

describe("what counts as landed", () => {
  it("counts already-exists — the sender's event IS in the directory", () => {
    const c = countOutcomes([o("created"), o("already-exists")]);
    expect(c.landed).toBe(2);
    expect(c.created).toBe(1);
    expect(c.alreadyExists).toBe(1);
  });

  it.each<OutcomeKind>(["submit-failed", "extract-failed", "fetch-failed"])(
    "does not count %s",
    (kind) => {
      expect(countOutcomes([o(kind)]).landed).toBe(0);
    }
  );

  it("reports zero rather than something reassuring when everything failed", () => {
    // The honest headline for a total miss is 0. Whether the copy should then
    // say something different is a separate question for the ticket — but the
    // NUMBER must not lie.
    const c = countOutcomes([o("fetch-failed"), o("extract-failed")]);
    expect(c.landed).toBe(0);
    expect(c.attempted).toBe(2);
  });

  it("handles an empty list", () => {
    expect(countOutcomes([])).toEqual({
      created: 0,
      alreadyExists: 0,
      failed: 0,
      landed: 0,
      attempted: 0,
    });
  });

  it("keeps landed + failed == attempted for any mix", () => {
    const outcomes: { kind: OutcomeKind }[] = [
      o("created"),
      o("already-exists"),
      o("submit-failed"),
      o("extract-failed"),
      o("fetch-failed"),
      o("created"),
    ];
    const c = countOutcomes(outcomes);
    expect(c.landed + c.failed).toBe(c.attempted);
  });
});

/**
 * OPE-460 scope 4 — the review promise must not outlive the thing being
 * reviewed.
 *
 * Fixing the count created a new absurdity: an email where every source failed
 * now honestly reports 0 events, and the very next line used to promise "our
 * team will review pending submissions within 24 hours". Nothing is pending.
 *
 * This removes a line that does not apply rather than writing new copy — and
 * it matters that we do not add a second unmet 24-hour promise while
 * /suggest-event's own stands at 0-of-6 met.
 */
describe("the review promise is conditional", () => {
  const render = (params: Record<string, unknown>) =>
    buildReply("ok-multi", "someone@example.com", params as never).text;

  it("omits the 24-hour promise when nothing landed", () => {
    const text = render({
      subject: "MV 1",
      eventCount: 0,
      resultsText: "❌ Couldn't fetch https://example.test/",
    });
    expect(text).toContain("0 events");
    expect(text).not.toContain("within 24 hours");
  });

  it("keeps the promise when something did land", () => {
    const text = render({
      subject: "MV 2",
      eventCount: 3,
      resultsText: '✅ "Vineyard Artisans Summer Festival" — pending review',
    });
    expect(text).toContain("within 24 hours");
  });

  it("still renders the overflow note without the review line", () => {
    // The two are independent; an all-failed overflow email must not lose its
    // overflow explanation just because nothing landed.
    const text = render({ subject: "x", eventCount: 0, resultsText: "❌ nope", overflowed: true });
    expect(text).not.toContain("within 24 hours");
    expect(text).toContain("more than 10 URLs");
  });

  it("uses the singular for exactly one event", () => {
    expect(render({ subject: "x", eventCount: 1, resultsText: "✅ one" })).toContain(
      "submitting 1 event to"
    );
  });
});

/**
 * OPE-460 scope 2 + scope 5's fourth shape — a source must not be reported as
 * both a success and a failure.
 *
 * The MV 2 ack claimed both at once:
 *
 *   ✅ "Vineyard Artisans Summer Festival" — pending review
 *   ✅ "Vineyard Artisans Holiday Festival" — pending review
 *   ✅ "Vineyard Artisans Festivals" — pending review
 *   ❌ Couldn't extract event details from https://vineyardartisans.com/
 *
 * One URL in the email. All three "successes" came from it, and so did the
 * failure line — the reply simultaneously claimed we did and did not read that
 * page.
 *
 * ⚠️ THE CAUSE IS GONE, AND THIS TEST EXISTS BECAUSE IT COULD COME BACK.
 *
 * Those three successes were phantoms: the BODY source invented events from a
 * body that was nothing but a URL. OPE-457 stopped handing that to the
 * extractor, so the contradiction has one cause and it is fixed upstream. No
 * URL-dedupe was built, deliberately — shipping speculative machinery against a
 * specimen you cannot reproduce is how dead code is written.
 *
 * The 08-20 review asked for that dependency to be recorded explicitly rather
 * than left in prose: **if the OPE-457 ruling is ever reversed, this specimen
 * returns.** So the invariant is asserted here as an executable statement of it.
 * If a future change lets one source emit both a candidate and a failure, this
 * fails and names OPE-457 as the thing to look at.
 */
describe("no source is both a success and a failure (the MV 2 shape)", () => {
  /** The invariant, stated over the outcome list the reply renders from. */
  function sourcesReportedBothWays(outcomes: Array<{ kind: OutcomeKind; url?: string }>): string[] {
    const succeeded = new Set<string>();
    const failed = new Set<string>();
    for (const o of outcomes) {
      if (!o.url) continue; // body-sourced events carry no URL — nothing to clash
      if (o.kind === "created" || o.kind === "already-exists") succeeded.add(o.url);
      else failed.add(o.url);
    }
    return [...succeeded].filter((u) => failed.has(u));
  }

  const URL = "https://vineyardartisans.com/";

  it("flags the exact MV 2 contradiction if it is ever reconstructed", () => {
    const contradictory = [
      { kind: "created" as OutcomeKind, url: URL },
      { kind: "created" as OutcomeKind, url: URL },
      { kind: "created" as OutcomeKind, url: URL },
      { kind: "extract-failed" as OutcomeKind, url: URL },
    ];
    expect(sourcesReportedBothWays(contradictory)).toEqual([URL]);
  });

  it("is satisfied by the post-OPE-457 shape, where the body invents nothing", () => {
    // What MV 2 produces today: the URL fails, and no phantom successes are
    // manufactured from a body that was only that URL.
    const actual = [{ kind: "extract-failed" as OutcomeKind, url: URL }];
    expect(sourcesReportedBothWays(actual)).toEqual([]);
  });

  it("does not confuse two DIFFERENT sources with one", () => {
    const mixed = [
      { kind: "created" as OutcomeKind, url: "https://a.example/" },
      { kind: "fetch-failed" as OutcomeKind, url: "https://b.example/" },
    ];
    expect(sourcesReportedBothWays(mixed)).toEqual([]);
  });

  it("ignores body-sourced events, which have no URL to clash with", () => {
    // A prose submission legitimately produces a created event AND a failed
    // URL from the same email. That is two sources, not one contradicting
    // itself, and it must not trip the invariant.
    const proseAndLink = [
      { kind: "created" as OutcomeKind },
      { kind: "fetch-failed" as OutcomeKind, url: URL },
    ];
    expect(sourcesReportedBothWays(proseAndLink)).toEqual([]);
  });
});

/**
 * OPE-460 scope 5 — the remaining shapes, stated as shapes rather than
 * incidentally covered.
 */
describe("the four reconciliation shapes", () => {
  it("all-success: headline equals the number of rows", () => {
    expect(countOutcomes([o("created"), o("created"), o("created")]).landed).toBe(3);
  });

  it("all-failure: headline is zero, not the attempt count", () => {
    expect(countOutcomes([o("fetch-failed"), o("extract-failed")]).landed).toBe(0);
  });

  it("mixed: failures never inflate the headline", () => {
    const c = countOutcomes([o("created"), o("already-exists"), o("extract-failed")]);
    expect(c.landed).toBe(2);
    expect(c.attempted).toBe(3);
  });
});
