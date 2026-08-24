/**
 * OPE-17 — unit tests for the inbound-email exception-notice gate + helpers.
 *
 * Mirrors roster-research-notice.test.ts: the pure decision gate carries the
 * debounce semantics (≤1/day AND only-on-change). The reconcile rails +
 * salvage-candidate predicate are DB-shaped and validated separately against a
 * throwaway SQLite (see the PR), the same way the OPE-20 migration was checked.
 */
import { describe, expect, it } from "vitest";
import { __test } from "../src/inbound-exception-notice.js";

const { decideInboundExceptionNotice, utcDayKey, escapeHtml, SALVAGE_INTENTS, NON_EVENT_INTENTS } =
  __test;

const TODAY = "2026-06-29";
const YESTERDAY = "2026-06-28";

describe("decideInboundExceptionNotice", () => {
  it("never notifies on an empty queue, even on first run", () => {
    expect(decideInboundExceptionNotice(0, null, null, TODAY)).toBe(false);
    expect(decideInboundExceptionNotice(-2, null, null, TODAY)).toBe(false);
  });

  it("notifies once for any non-empty queue on first run", () => {
    expect(decideInboundExceptionNotice(7, null, null, TODAY)).toBe(true);
  });

  it("skips when already notified today, even if the count changed", () => {
    expect(decideInboundExceptionNotice(12, TODAY, 7, TODAY)).toBe(false);
  });

  it("skips an unchanged backlog on a later day (don't nag)", () => {
    expect(decideInboundExceptionNotice(7, YESTERDAY, 7, TODAY)).toBe(false);
  });

  it("notifies when the queue grew or shrank since the last notice", () => {
    expect(decideInboundExceptionNotice(9, YESTERDAY, 7, TODAY)).toBe(true);
    expect(decideInboundExceptionNotice(4, YESTERDAY, 7, TODAY)).toBe(true);
  });

  it("requires BOTH a new day AND a changed count to fire", () => {
    expect(decideInboundExceptionNotice(9, YESTERDAY, 7, TODAY)).toBe(true); // new day + changed
    expect(decideInboundExceptionNotice(7, YESTERDAY, 7, TODAY)).toBe(false); // new day, unchanged
    expect(decideInboundExceptionNotice(9, TODAY, 7, TODAY)).toBe(false); // changed, same day
  });
});

describe("intent constants (queue + disposition scope)", () => {
  it("salvage queue is scoped to real event-submission intents", () => {
    // OPE-532 added `photo_intake`. Someone emailing a photo of a fair is
    // making a real submission attempt, and prod held a `status='failed'`
    // photo intake (2026-08-10) that no count has ever included, because the
    // intent allow-list excluded it. Deliberate change; this pin caught it,
    // which is exactly what it is for.
    expect([...SALVAGE_INTENTS]).toEqual(["new_event", "submit", "photo_intake"]);
  });
  it("auto-disposition is limited to unambiguous non-event intents (not 'unclear')", () => {
    expect([...NON_EVENT_INTENTS]).toEqual(["spam", "unsubscribe"]);
    expect(NON_EVENT_INTENTS).not.toContain("unclear");
  });
});

describe("helpers", () => {
  it("utcDayKey formats UTC YYYY-MM-DD and is stable near midnight", () => {
    expect(utcDayKey(new Date("2026-06-29T13:37:00Z"))).toBe("2026-06-29");
    expect(utcDayKey(new Date("2026-06-29T23:59:59Z"))).toBe("2026-06-29");
  });
  it("escapeHtml escapes subject/address special chars", () => {
    expect(escapeHtml('Fair & "Expo" <b>')).toBe("Fair &amp; &quot;Expo&quot; &lt;b&gt;");
  });
});

describe("OPE-532 — a flat queue that is ageing still speaks", () => {
  const { ageBucket } = __test;

  it("stays silent on an unchanged count that has not aged into a new bucket", () => {
    // The original rule, unchanged: same size, same bucket, nothing new to say.
    expect(decideInboundExceptionNotice(9, YESTERDAY, 9, TODAY, ageBucket(4), 3)).toBe(false);
  });

  it("speaks when the oldest item crosses a threshold, though the count is identical", () => {
    // The hole this closes. A backlog frozen at 9 for a month was, to the old
    // gate, indistinguishable from one nobody needed to hear about.
    expect(decideInboundExceptionNotice(9, YESTERDAY, 9, TODAY, ageBucket(8), 3)).toBe(true);
  });

  it("does not speak twice for the same bucket", () => {
    expect(decideInboundExceptionNotice(9, YESTERDAY, 9, TODAY, ageBucket(20), 14)).toBe(false);
  });

  it("treats a null stored bucket as 'never escalated' rather than zero", () => {
    // Rows predating drizzle/0227. Reading null as 0 would make the first
    // ageing queue after deploy fire on a bucket it had already lived through.
    expect(decideInboundExceptionNotice(9, YESTERDAY, 9, TODAY, ageBucket(40), null)).toBe(false);
  });

  it("never sends twice in one day, whatever the escalation", () => {
    // The once-a-day rule outranks escalation.
    expect(decideInboundExceptionNotice(9, TODAY, 9, TODAY, ageBucket(90), 3)).toBe(false);
  });

  it("still refuses to speak about an empty queue however old it was", () => {
    expect(decideInboundExceptionNotice(0, YESTERDAY, 9, TODAY, ageBucket(90), 3)).toBe(false);
  });

  it("keeps the count-change path working regardless of age", () => {
    expect(decideInboundExceptionNotice(11, YESTERDAY, 9, TODAY, ageBucket(0), null)).toBe(true);
  });
});
