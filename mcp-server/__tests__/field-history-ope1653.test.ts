/**
 * OPE-1653 — field history, part 2: the unattended content writers.
 *
 * OPE-1651 wired the interactive edit paths into `entity_field_history`; the
 * writers below still replaced a value with no record of what it replaced. One
 * test per group of the ticket's scope (MCP side; the app-side groups are in
 * `src/lib/__tests__/field-history-app-ope1653.test.ts`), plus the shared
 * `updateWithFieldHistory` helper every group now calls.
 *
 * Every positive assertion names the row it expects; every "no row" assertion
 * sits beside a landmark proving the write itself ran (v3.8).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { unsafeSlug } from "@takemetothefair/utils";
import { updateWithFieldHistory } from "@takemetothefair/db-schema/field-history";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import {
  entityFieldHistory,
  events,
  promoters,
  users,
  vendorEnrichmentCandidates,
  vendors,
} from "../src/schema.js";
import { runSyncStaleSweep } from "../src/sync-stale-sweep.js";
import { applyFieldValue } from "../src/feeds/provenance.js";
import { applyDenormColumn } from "../src/tools/admin-citations.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { registerOrganizerFeedTools } from "../src/tools/admin-organizer-feeds.js";
import { applyCardPlan } from "../src/photo/business-card.js";

const NOW = new Date("2026-11-26T12:00:00Z");
let db: TestDb;

const history = () => db.select().from(entityFieldHistory).all();
const event = (id: string) => db.select().from(events).where(eq(events.id, id)).all()[0];

beforeEach(() => {
  ({ db } = createTestDb());
  db.insert(promoters)
    .values({ id: "p1", companyName: "P", slug: unsafeSlug("p") })
    .run();
  db.insert(events)
    .values({
      id: "e1",
      name: "Fryeburg Fair",
      slug: unsafeSlug("fryeburg-fair"),
      promoterId: "p1",
      status: "APPROVED",
      startDate: new Date("2027-10-03T12:00:00Z"),
      endDate: new Date("2027-10-10T12:00:00Z"),
      datesConfirmed: true,
      syncEnabled: true,
      estimatedAttendance: 1000,
      lastSyncedAt: new Date("2026-01-01T00:00:00Z"),
      createdAt: new Date("2025-01-01T00:00:00Z"),
    })
    .run();
});

describe("updateWithFieldHistory — the shared write helper", () => {
  it("writes the UPDATE and one row per changed field, reading the before-row itself", async () => {
    const rows = await updateWithFieldHistory(db as never, {
      table: events,
      entityType: "event",
      entityId: "e1",
      patch: { name: "Fryeburg Fair 2027", estimatedAttendance: 1000, updatedAt: NOW },
      actor: "system:test",
      source: "test",
    });
    expect(event("e1").name).toBe("Fryeburg Fair 2027");
    // estimatedAttendance unchanged and updatedAt bookkeeping → no rows for them.
    expect(rows.map((r) => r.field)).toEqual(["name"]);
    expect(history()).toMatchObject([
      { entityId: "e1", field: "name", oldValue: "Fryeburg Fair", newValue: "Fryeburg Fair 2027" },
    ]);
  });

  it("still runs the UPDATE when nothing tracked changed, and writes no row", async () => {
    await updateWithFieldHistory(db as never, {
      table: events,
      entityType: "event",
      entityId: "e1",
      patch: { name: "Fryeburg Fair", lastSyncedAt: NOW },
      actor: "system:test",
      source: "test",
      ignore: ["lastSyncedAt"],
    });
    expect(event("e1").lastSyncedAt?.toISOString()).toBe(NOW.toISOString()); // landmark
    expect(history()).toEqual([]);
  });

  it("writes no history for a missing row", async () => {
    const rows = await updateWithFieldHistory(db as never, {
      table: events,
      entityType: "event",
      entityId: "nope",
      patch: { name: "X" },
      actor: "system:test",
      source: "test",
    });
    expect(rows).toEqual([]);
    expect(history()).toEqual([]);
  });
});

describe("group 1 — rescrape / sync: the sync-stale sweep's datesConfirmed downgrade", () => {
  it("records true → false, actor system:sync-stale-sweep", async () => {
    const res = await runSyncStaleSweep(db, NOW);
    expect(res.downgraded).toEqual(["e1"]); // landmark: the sweep did downgrade it
    expect(history()).toMatchObject([
      {
        entityType: "event",
        entityId: "e1",
        field: "dates_confirmed",
        oldValue: "true",
        newValue: "false",
        actor: "system:sync-stale-sweep",
        source: "mcp:schedule:sync-stale-sweep",
      },
    ]);
  });
});

describe("group 2 — feed ingestion: a validated contact's date answer", () => {
  it("records the start date it moved", async () => {
    const r = await applyFieldValue(db, "e1", "start_date", "2027-10-04");
    expect(r.applied).toBe(true);
    const rows = history();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entityId: "e1",
      field: "start_date",
      oldValue: "2027-10-03T12:00:00.000Z",
      actor: "system:feed-contact-answer",
    });
    expect(rows[0].newValue).toMatch(/^2027-10-04T/);
  });

  it("a missing event writes nothing and says so", async () => {
    const r = await applyFieldValue(db, "nope", "start_date", "2027-10-04");
    expect(r).toEqual({ applied: false, reason: "event not found" });
    expect(history()).toEqual([]);
  });
});

describe("group 3 — enrichment review apply: a forced vendor_type overwrite", () => {
  it("records what the forced approve replaced, attributed to the reviewer", async () => {
    db.insert(users).values({ id: "u-v", email: "v@test", role: "VENDOR" }).run();
    db.insert(vendors)
      .values({
        id: "v-1",
        userId: "u-v",
        businessName: "Fine Fettle",
        slug: unsafeSlug("fine-fettle"),
        vendorType: "Home Improvement",
      })
      .run();
    db.insert(vendorEnrichmentCandidates)
      .values({
        id: 1,
        vendorId: "v-1",
        jobRunId: "job-1",
        extractionMethod: "manual",
        proposedField: "vendor_type",
        currentValue: "Home Improvement",
        proposedValue: "Cannabis Dispensary",
        sourceUrl: "https://finefettle.com",
        decision: "pending",
        flags: "[]",
        createdAt: NOW,
      })
      .run();
    const server = new CapturingMcpServer();
    registerAdminTools(server as never, db, { userId: "u-admin", role: "ADMIN" as const });

    await server.invoke("review_enrichment_candidate", {
      candidate_id: 1,
      action: "approve",
      force: true,
    });

    const after = db.select().from(vendors).where(eq(vendors.id, "v-1")).all()[0];
    expect(after.vendorType).not.toBe("Home Improvement"); // landmark: the overwrite landed
    expect(history()).toMatchObject([
      {
        entityType: "vendor",
        entityId: "v-1",
        field: "vendor_type",
        oldValue: "Home Improvement",
        newValue: after.vendorType,
        actor: "u-admin",
        source: "mcp:review_enrichment_candidate (approve)",
      },
    ]);
  });
});

describe("group 6 — other content writes: a citation's denormalised column", () => {
  it("records the attendance a citation replaced", async () => {
    const r = await applyDenormColumn(db, "e1", "estimated_attendance", "250,000");
    expect(r.skipReason).toBeNull();
    expect(event("e1").estimatedAttendance).toBe(250000); // landmark
    expect(history()).toMatchObject([
      {
        entityId: "e1",
        field: "estimated_attendance",
        oldValue: "1000",
        newValue: "250000",
        actor: "system:citation-denorm",
      },
    ]);
  });

  it("an unchanged citation value writes neither the column nor a row", async () => {
    const r = await applyDenormColumn(db, "e1", "estimated_attendance", "1000");
    expect(r.skipReason).toBe("unchanged");
    expect(history()).toEqual([]);
  });
});

describe("found by the inventory re-grep — writers shipped after #1806", () => {
  it("a business card's guarded vendor fill records null → the card's value", async () => {
    db.insert(users).values({ id: "u-v", email: "v@test", role: "VENDOR" }).run();
    db.insert(vendors)
      .values({ id: "v-2", userId: "u-v", businessName: "Kettle Corn Co", slug: unsafeSlug("kc") })
      .run();
    const res = await applyCardPlan(
      db,
      "v-2",
      [
        {
          column: "contact_phone",
          value: "207-555-0100",
          confidence: 0.95,
          current: null,
          action: "write",
        },
      ],
      { sourceRef: "inbound:abc", jobRunId: "job-1" },
      NOW
    );
    expect(res.written).toEqual(["contact_phone"]); // landmark
    expect(history()).toMatchObject([
      {
        entityType: "vendor",
        entityId: "v-2",
        field: "contact_phone",
        oldValue: null,
        newValue: "207-555-0100",
        actor: "system:business-card",
        requestId: "inbound:abc",
      },
    ]);
  });

  it("set_promoter_camps_workshops records the flag it flipped", async () => {
    db.insert(users).values({ id: "u-p", email: "p@test", role: "PROMOTER" }).run();
    db.update(promoters).set({ claimed: true, userId: "u-p" }).where(eq(promoters.id, "p1")).run();
    const server = new CapturingMcpServer();
    registerOrganizerFeedTools(server as never, db, { userId: "u-admin", role: "ADMIN" as const });

    await server.invoke("set_promoter_camps_workshops", { promoter_id: "p1", enabled: true });

    const after = db.select().from(promoters).where(eq(promoters.id, "p1")).all()[0];
    expect(after.includeCampsWorkshops).toBe(true); // landmark
    expect(history()).toMatchObject([
      {
        entityType: "promoter",
        entityId: "p1",
        field: "include_camps_workshops",
        newValue: "true",
        actor: "u-admin",
        source: "mcp:set_promoter_camps_workshops",
      },
    ]);
  });
});
