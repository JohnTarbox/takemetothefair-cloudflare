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
    expect([...SALVAGE_INTENTS]).toEqual(["new_event", "submit"]);
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
