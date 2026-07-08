/**
 * OPE-124 — performer data-health checks. Verifies each of the 7 checks catches
 * its violation AND that clean data produces ZERO findings (the acceptance's
 * no-false-positive requirement — esp. the ±2d grace on time-out-of-range so a
 * legit afternoon set on the closing day isn't flagged).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import { events, eventPerformers, performers, eventDays, promoters } from "../src/schema.js";
import { getPerformerDataHealth } from "../src/tools/admin-performer-health.js";

let db: TestDb;
const DAY = 86400_000; // ms
const now = 1_780_000_000_000; // fixed ms epoch for deterministic windows
const at = (msFromNow: number) => new Date(now + msFromNow);

// getPerformerDataHealth reads Date.now(); pin it so windows are deterministic.
const realNow = Date.now;
beforeEach(() => {
  Date.now = () => now;
  ({ db } = createTestDb());
  db.insert(promoters).values({ id: "p1", companyName: "P", slug: "p" }).run();
});
afterEach(() => {
  Date.now = realNow;
});

function insEvent(id: string, o: Record<string, unknown> = {}) {
  db.insert(events)
    .values({
      id,
      name: `E ${id}`,
      slug: `e-${id}`,
      promoterId: "p1",
      status: "APPROVED",
      ...o,
    } as never)
    .run();
}
function insPerformer(id: string, o: Record<string, unknown> = {}) {
  db.insert(performers)
    .values({ id, name: o.name ?? `Act ${id}`, slug: `s-${id}`, ...o } as never)
    .run();
}
function insAppr(
  id: string,
  eventId: string,
  performerId: string,
  o: Record<string, unknown> = {}
) {
  db.insert(eventPerformers)
    .values({ id, eventId, performerId, status: "CONFIRMED", ...o } as never)
    .run();
}

describe("getPerformerDataHealth", () => {
  it("clean data → zero findings (incl. an afternoon set on closing day)", async () => {
    // Future event, roster freshly checked, CONFIRMED w/ provenance, and a
    // performance at 3pm on the LAST day (end_date is midnight → would false-
    // positive without the grace).
    insEvent("clean", {
      startDate: at(10 * DAY),
      endDate: at(11 * DAY),
      performerRosterCheckedAt: at(-1 * DAY),
      performerRosterStatus: "VERIFIED",
    });
    insPerformer("pc");
    insAppr("a-clean", "clean", "pc", {
      status: "CONFIRMED",
      sourceUrl: "https://fair.example/lineup",
      performanceStart: at(11 * DAY + 15 * 3600_000), // 3pm on closing day
    });

    const r = await getPerformerDataHealth(db);
    expect(r.total_findings).toBe(0);
  });

  it("check 1 — past event still PENDING", async () => {
    insEvent("past", { startDate: at(-3 * DAY), endDate: at(-2 * DAY) });
    insPerformer("p");
    insAppr("a", "past", "p", { status: "PENDING" });
    const r = await getPerformerDataHealth(db);
    expect(r.checks.find((c) => c.key === "past_but_pending")!.count).toBe(1);
  });

  it("check 2 — time out of range (wrong month) but NOT a same-day time", async () => {
    insEvent("ev", { startDate: at(5 * DAY), endDate: at(6 * DAY) });
    insPerformer("p");
    insAppr("bad", "ev", "p", { performanceStart: at(60 * DAY) }); // ~2 months off
    insAppr("ok", "ev", "p", { performanceStart: at(6 * DAY + 14 * 3600_000) }); // 2pm closing day
    const r = await getPerformerDataHealth(db);
    const c = r.checks.find((c) => c.key === "time_out_of_range")!;
    expect(c.count).toBe(1);
    expect((c.findings[0] as { appearance_id: string }).appearance_id).toBe("bad");
  });

  it("check 3 — imminent event with a stale (null-checked) lineup; empty lineup NOT flagged", async () => {
    insEvent("soon", {
      startDate: at(3 * DAY),
      endDate: at(4 * DAY),
      performerRosterCheckedAt: null,
    });
    insPerformer("p");
    insAppr("a", "soon", "p", { status: "CONFIRMED" });
    // Imminent but NO lineup → must not be flagged.
    insEvent("soon-empty", { startDate: at(2 * DAY), endDate: at(3 * DAY) });
    const r = await getPerformerDataHealth(db);
    const c = r.checks.find((c) => c.key === "stale_imminent_lineup")!;
    expect(c.count).toBe(1);
    expect((c.findings[0] as { event_id: string }).event_id).toBe("soon");
  });

  it("check 4 — appearance on a tombstoned performer or merged event", async () => {
    insEvent("ev", { startDate: at(5 * DAY), endDate: at(6 * DAY) });
    insPerformer("dead", { deletedAt: at(-1 * DAY), redirectToPerformerId: "keeper" });
    insAppr("a1", "ev", "dead");
    insEvent("merged", { startDate: at(5 * DAY), endDate: at(6 * DAY), mergedInto: "keeper-ev" });
    insPerformer("p");
    insAppr("a2", "merged", "p");
    const r = await getPerformerDataHealth(db);
    expect(r.checks.find((c) => c.key === "orphaned_appearance")!.count).toBe(2);
  });

  it("check 5 — CONFIRMED appearance with no source_url", async () => {
    insEvent("ev", { startDate: at(5 * DAY), endDate: at(6 * DAY) });
    insPerformer("p");
    insAppr("a", "ev", "p", { status: "CONFIRMED", sourceUrl: null });
    const r = await getPerformerDataHealth(db);
    expect(r.checks.find((c) => c.key === "missing_provenance")!.count).toBe(1);
  });

  it("check 6 — near-duplicate performers", async () => {
    insPerformer("d1", { name: "The Smith Family Band" });
    insPerformer("d2", { name: "The Smith Family Band!" });
    const r = await getPerformerDataHealth(db);
    expect(r.checks.find((c) => c.key === "duplicate_performers")!.count).toBeGreaterThanOrEqual(1);
  });

  it("check 7 — appearance attached to another event's day", async () => {
    insEvent("evA", { startDate: at(5 * DAY), endDate: at(6 * DAY) });
    insEvent("evB", { startDate: at(400 * DAY), endDate: at(401 * DAY) });
    db.insert(eventDays)
      .values({ id: "dayB", eventId: "evB", date: "2027-08-01" } as never)
      .run();
    insPerformer("p");
    insAppr("a", "evA", "p", { eventDayId: "dayB" }); // day belongs to evB
    const r = await getPerformerDataHealth(db);
    const c = r.checks.find((c) => c.key === "cross_year_carry")!;
    expect(c.count).toBe(1);
    expect((c.findings[0] as { appearance_id: string }).appearance_id).toBe("a");
  });
});
