import { describe, it, expect } from "vitest";
import {
  EVENT_LIFECYCLE,
  EVENT_LIFECYCLE_VALUES,
  PUBLIC_LIFECYCLE_STATUSES,
  LIFECYCLE_TO_SCHEMA_ORG,
  LIFECYCLE_TRANSITIONS,
  validateLifecycleTransition,
  isPublicLifecycle,
  schemaOrgEventStatusFor,
  swapDatesForLifecycle,
  publicEventWhere,
  type EventLifecycle,
} from "../event-lifecycle";

// Lifecycle state-machine drives every admin decision about real-world
// event status. These are pure functions — the value of the tests is
// nailing down the transition matrix, the schema.org URI map, and the
// public-visibility split, so adding a new lifecycle value without
// updating these tables fails CI instead of silently rendering as
// "undefined" in EventSchema.tsx or excluding events from the sitemap.

describe("EVENT_LIFECYCLE enum coverage", () => {
  it("EVENT_LIFECYCLE_VALUES covers every key in EVENT_LIFECYCLE", () => {
    expect(EVENT_LIFECYCLE_VALUES.length).toBe(Object.keys(EVENT_LIFECYCLE).length);
    for (const value of Object.values(EVENT_LIFECYCLE)) {
      expect(EVENT_LIFECYCLE_VALUES).toContain(value);
    }
  });

  it("PUBLIC_LIFECYCLE_STATUSES excludes CANCELLED and NO_SHOW", () => {
    expect(PUBLIC_LIFECYCLE_STATUSES).not.toContain(EVENT_LIFECYCLE.CANCELLED);
    expect(PUBLIC_LIFECYCLE_STATUSES).not.toContain(EVENT_LIFECYCLE.NO_SHOW);
  });

  it("PUBLIC_LIFECYCLE_STATUSES includes the visible-state members", () => {
    expect(PUBLIC_LIFECYCLE_STATUSES).toContain(EVENT_LIFECYCLE.SCHEDULED);
    expect(PUBLIC_LIFECYCLE_STATUSES).toContain(EVENT_LIFECYCLE.TENTATIVE);
    expect(PUBLIC_LIFECYCLE_STATUSES).toContain(EVENT_LIFECYCLE.POSTPONED);
    expect(PUBLIC_LIFECYCLE_STATUSES).toContain(EVENT_LIFECYCLE.RESCHEDULED);
    expect(PUBLIC_LIFECYCLE_STATUSES).toContain(EVENT_LIFECYCLE.OCCURRED);
    expect(PUBLIC_LIFECYCLE_STATUSES).toContain(EVENT_LIFECYCLE.MOVED_ONLINE);
  });

  it("isPublicLifecycle aligns with PUBLIC_LIFECYCLE_STATUSES", () => {
    for (const value of EVENT_LIFECYCLE_VALUES) {
      const isPublic = isPublicLifecycle(value);
      const inSet = (PUBLIC_LIFECYCLE_STATUSES as readonly string[]).includes(value);
      expect(isPublic).toBe(inSet);
    }
  });
});

describe("LIFECYCLE_TO_SCHEMA_ORG map", () => {
  it("covers every lifecycle value", () => {
    for (const value of EVENT_LIFECYCLE_VALUES) {
      expect(value in LIFECYCLE_TO_SCHEMA_ORG).toBe(true);
    }
  });

  it("future-state lifecycles map to schema.org URIs", () => {
    expect(LIFECYCLE_TO_SCHEMA_ORG.SCHEDULED).toBe("https://schema.org/EventScheduled");
    expect(LIFECYCLE_TO_SCHEMA_ORG.TENTATIVE).toBe("https://schema.org/EventScheduled");
    expect(LIFECYCLE_TO_SCHEMA_ORG.POSTPONED).toBe("https://schema.org/EventPostponed");
    expect(LIFECYCLE_TO_SCHEMA_ORG.RESCHEDULED).toBe("https://schema.org/EventRescheduled");
    expect(LIFECYCLE_TO_SCHEMA_ORG.CANCELLED).toBe("https://schema.org/EventCancelled");
    expect(LIFECYCLE_TO_SCHEMA_ORG.MOVED_ONLINE).toBe("https://schema.org/EventMovedOnline");
  });

  it("past-state lifecycles return null (no schema.org equivalent)", () => {
    expect(LIFECYCLE_TO_SCHEMA_ORG.OCCURRED).toBeNull();
    expect(LIFECYCLE_TO_SCHEMA_ORG.NO_SHOW).toBeNull();
  });

  it("schemaOrgEventStatusFor is a pass-through", () => {
    for (const value of EVENT_LIFECYCLE_VALUES) {
      expect(schemaOrgEventStatusFor(value)).toBe(LIFECYCLE_TO_SCHEMA_ORG[value]);
    }
  });
});

describe("LIFECYCLE_TRANSITIONS table", () => {
  it("covers every lifecycle value", () => {
    for (const value of EVENT_LIFECYCLE_VALUES) {
      expect(value in LIFECYCLE_TRANSITIONS).toBe(true);
    }
  });

  it("transitions reference only valid lifecycle values", () => {
    for (const [from, targets] of Object.entries(LIFECYCLE_TRANSITIONS)) {
      for (const to of targets) {
        expect(EVENT_LIFECYCLE_VALUES).toContain(to);
        expect(to).not.toBe(from); // No self-transitions in the table
      }
    }
  });

  it("CANCELLED → SCHEDULED is allowed (uncancellation)", () => {
    expect(validateLifecycleTransition("CANCELLED", "SCHEDULED").ok).toBe(true);
  });

  it("OCCURRED ↔ NO_SHOW are the only OCCURRED transitions", () => {
    expect(validateLifecycleTransition("OCCURRED", "NO_SHOW").ok).toBe(true);
    expect(validateLifecycleTransition("NO_SHOW", "OCCURRED").ok).toBe(true);
    expect(validateLifecycleTransition("OCCURRED", "SCHEDULED").ok).toBe(false);
    expect(validateLifecycleTransition("OCCURRED", "CANCELLED").ok).toBe(false);
  });

  it("rejects self-transitions as no-ops", () => {
    for (const value of EVENT_LIFECYCLE_VALUES) {
      const result = validateLifecycleTransition(value, value);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("no-op");
    }
  });

  it("returns allowed targets on rejection so the API can give a helpful error", () => {
    const result = validateLifecycleTransition("OCCURRED", "SCHEDULED");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.allowed).toContain("NO_SHOW" as EventLifecycle);
      expect(result.reason).toContain("OCCURRED");
      expect(result.reason).toContain("SCHEDULED");
    }
  });

  it("SCHEDULED can reach every other state directly", () => {
    for (const target of EVENT_LIFECYCLE_VALUES) {
      if (target === "SCHEDULED") continue;
      const result = validateLifecycleTransition("SCHEDULED", target);
      expect(result.ok, `SCHEDULED → ${target} should be allowed`).toBe(true);
    }
  });
});

describe("swapDatesForLifecycle", () => {
  it("moves current dates into previous, adopts next dates", () => {
    const current = { startDate: new Date("2026-06-15"), endDate: new Date("2026-06-16") };
    const next = { startDate: new Date("2026-09-01"), endDate: new Date("2026-09-02") };
    const result = swapDatesForLifecycle(current, next);
    expect(result.startDate?.toISOString().slice(0, 10)).toBe("2026-09-01");
    expect(result.endDate?.toISOString().slice(0, 10)).toBe("2026-09-02");
    expect(result.previousStartDate?.toISOString().slice(0, 10)).toBe("2026-06-15");
    expect(result.previousEndDate?.toISOString().slice(0, 10)).toBe("2026-06-16");
  });

  it("handles POSTPONED with null next dates (dates not yet known)", () => {
    const current = { startDate: new Date("2026-06-15"), endDate: new Date("2026-06-16") };
    const result = swapDatesForLifecycle(current, { startDate: null, endDate: null });
    expect(result.startDate).toBeNull();
    expect(result.endDate).toBeNull();
    expect(result.previousStartDate?.toISOString().slice(0, 10)).toBe("2026-06-15");
  });

  it("does not mutate the input objects", () => {
    const current = { startDate: new Date("2026-06-15"), endDate: new Date("2026-06-16") };
    const currentCopy = { ...current };
    const next = { startDate: new Date("2026-09-01"), endDate: new Date("2026-09-02") };
    swapDatesForLifecycle(current, next);
    expect(current.startDate?.toISOString()).toBe(currentCopy.startDate?.toISOString());
  });
});

describe("publicEventWhere", () => {
  it("constructs a Drizzle clause without throwing", () => {
    // Same pattern as isPublicEventStatus test — clause is opaque but
    // construction must succeed. Behavioral correctness is covered by
    // /events page integration tests once the migration applies.
    const clause = publicEventWhere();
    expect(clause).toBeDefined();
  });
});
