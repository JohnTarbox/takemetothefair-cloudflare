/**
 * OPE-433 scope 5 — venue and event_day writes must be answerable.
 *
 * The specimen: venue `5e6f81ed` was mutated in production at 04:00:20Z on
 * 2026-08-17 — city normalised, address filled, lat/long set — and an agent, a
 * `venues_geocode` sweep and the mafa.org importer were indistinguishable from
 * the evidence, because there was none.
 */
import { describe, expect, it } from "vitest";
import { buildMutationAudit, diffAuditedFields, AUDITED_FIELDS } from "./mutation-audit";

const NOW = new Date("2026-08-18T20:30:00Z");

describe("the Martha's Vineyard specimen, replayed", () => {
  const row = buildMutationAudit(
    {
      entityType: "venue",
      entityId: "5e6f81ed-83e2-455a-b2e0-f70e074af257",
      verb: "update",
      actor: "venues_geocode",
      before: { city: "West Tisbury MA", address: "", latitude: null, longitude: null },
      after: {
        city: "West Tisbury",
        address: "35 Panhandle Rd",
        latitude: 41.381,
        longitude: -70.64,
      },
      note: "geocode sweep",
    },
    NOW
  );

  it("names what did it", () => {
    // The entire cost of the specimen was that this question had no answer.
    expect(row).not.toBeNull();
    expect(JSON.parse(row!.payloadJson).actor).toBe("venues_geocode");
  });

  it("records every field the write actually changed", () => {
    const changed = JSON.parse(row!.payloadJson).changed;
    expect(Object.keys(changed).sort()).toEqual(["address", "city", "latitude", "longitude"]);
    expect(changed.city).toEqual({ from: "West Tisbury MA", to: "West Tisbury" });
  });

  it("does not put a machine identity in the user-id column", () => {
    // `actor_user_id` is a user id. Writing "venues_geocode" there would make a
    // sweep look like a person, which is a worse answer than none.
    expect(row!.actorUserId).toBeNull();
    expect(row!.targetType).toBe("venue");
    expect(row!.action).toBe("venue.update");
  });
});

describe("a human actor keeps the user-id column", () => {
  it("threads a real user id", () => {
    const row = buildMutationAudit(
      {
        entityType: "venue",
        entityId: "v1",
        verb: "update",
        actor: "admin-user-001",
        before: { name: "Old" },
        after: { name: "New" },
      },
      NOW
    );
    expect(row!.actorUserId).toBe("admin-user-001");
  });
});

describe("silence when there is nothing to say", () => {
  it("returns null for an update that changed no audited field", () => {
    // A write that touched only `updated_at` is not an event in the record, and
    // logging it would bury the ones that are.
    expect(
      buildMutationAudit(
        {
          entityType: "venue",
          entityId: "v1",
          verb: "update",
          actor: "x",
          before: { name: "Same", capacity: 100 },
          after: { name: "Same", capacity: 250 },
        },
        NOW
      )
    ).toBeNull();
  });

  it("still records a create even with a thin row", () => {
    // The existence of the row IS the fact being recorded.
    const row = buildMutationAudit(
      { entityType: "event_day", entityId: "d1", verb: "create", actor: "import-url", after: {} },
      NOW
    );
    expect(row).not.toBeNull();
    expect(row!.action).toBe("event_day.create");
  });

  it("still records a delete", () => {
    const row = buildMutationAudit(
      { entityType: "event_day", entityId: "d1", verb: "delete", actor: "admin-user-001" },
      NOW
    );
    expect(row!.action).toBe("event_day.delete");
  });

  it("refuses to build an anonymous row", () => {
    // An audit row that cannot say who is the specimen's failure with extra
    // steps: it records that something happened and still cannot answer what.
    expect(
      buildMutationAudit({ entityType: "venue", entityId: "v1", verb: "update", actor: "" }, NOW)
    ).toBeNull();
  });
});

describe("diffAuditedFields", () => {
  it("ignores fields nobody reads off the public page", () => {
    expect(
      diffAuditedFields("venue", { updatedAt: 1, viewCount: 3 }, { updatedAt: 2, viewCount: 9 })
    ).toEqual({});
  });

  it("distinguishes 'not touched' from 'set to null'", () => {
    // A patch that omits `zip` says nothing about it, so `zip` must not appear
    // in the diff — even though the same patch does change something else.
    const untouched = diffAuditedFields("venue", { zip: "04966" }, { name: "X" });
    expect(untouched).not.toHaveProperty("zip");

    // Setting it to null is CLEARING a published address field, which is
    // exactly the kind of edit this exists to catch.
    expect(diffAuditedFields("venue", { zip: "04966" }, { zip: null })).toEqual({
      zip: { from: "04966", to: null },
    });
  });

  it("does not report a driver type change as an edit", () => {
    // D1 hands back 1 where Drizzle wrote "1". Reporting that as a change would
    // fill the log with noise from the driver rather than anybody's edit.
    expect(diffAuditedFields("event_day", { closed: 1 }, { closed: "1" })).toEqual({});
  });

  it("keeps the two entities' field lists separate", () => {
    expect(AUDITED_FIELDS.venue.has("openTime")).toBe(false);
    expect(AUDITED_FIELDS.event_day.has("zip")).toBe(false);
    expect(AUDITED_FIELDS.event_day.has("openTime")).toBe(true);
  });

  it("catches the OPE-421 shape — a venue name overwritten with an event name", () => {
    expect(
      diffAuditedFields(
        "venue",
        { name: "Dartmouth Grange #162" },
        { name: "Dartmouth Grange Fair 2026" }
      )
    ).toEqual({ name: { from: "Dartmouth Grange #162", to: "Dartmouth Grange Fair 2026" } });
  });
});
