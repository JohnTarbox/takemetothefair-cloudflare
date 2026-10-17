/**
 * OPE-1484 — enrich-on-match stages the organizer's parking / accessibility /
 * pet sentences (the extract route's deterministic `visitorFacts`) as
 * `{ value, excerpt }` proposals: exactly the evidence `update_event` needs to
 * apply them (OPE-1061 / OPE-1481). Staging only — the matched event row must
 * be byte-identical afterwards.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "./setup-db.js";

const harness: { db: unknown } = { db: null };
vi.mock("../src/db.js", () => ({ getDb: () => harness.db }));

import {
  ENRICH_NOTHING_STAGED_ACTION,
  ENRICH_PROPOSED_ACTION,
  computeEnrichDisposition,
  incomingFromExtracted,
  stageEnrichOnMatch,
} from "../src/email-handlers/enrich-proposal.js";
import type { Db } from "../src/db.js";

let raw: ReturnType<typeof createTestDb>["raw"];
beforeEach(() => {
  const t = createTestDb();
  harness.db = t.db;
  raw = t.raw;
});
const db = () => harness.db as Db;

function seedEvent(id: string, cols: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id,
    name: `Event ${id}`,
    slug: `event-${id}`,
    promoter_id: "p1",
    status: "APPROVED",
    ...cols,
  };
  const keys = Object.keys(row);
  raw
    .prepare(`INSERT INTO events (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
    .run(...keys.map((k) => row[k] as never));
}
const eventRow = (id: string) => raw.prepare(`SELECT * FROM events WHERE id = ?`).get(id);
const lastAction = () => {
  const r = raw
    .prepare(
      `SELECT action, payload_json FROM admin_actions WHERE action LIKE 'dedup.enrich%' ORDER BY rowid DESC LIMIT 1`
    )
    .get() as { action: string; payload_json: string };
  return { action: r.action, payload: JSON.parse(r.payload_json) as Record<string, unknown> };
};

// The Pemaquid specimen (OPE-1152 `9e5b0816`): its organizer page said this,
// and nothing could stage it.
const PEMAQUID_ACCESS = "The first floor is fully accessible.";
const ZOO_PETS =
  "Pets are not allowed on Zoo grounds to protect the health and safety of our animals and your pets.";
const ZOO_PARKING = "No, parking is free in our nearby lots.";

describe("stageEnrichOnMatch — visitor facts (OPE-1484)", () => {
  it("Pemaquid: the accessibility sentence stages as { value, excerpt }, and the event is untouched", async () => {
    seedEvent("pq", { description: "The Pemaquid Oyster Festival returns to Damariscotta." });
    const before = eventRow("pq");
    const out = await stageEnrichOnMatch(db(), {
      existingEventId: "pq",
      url: "https://pemaquidoysterfestival.com/",
      event: {
        name: "Pemaquid Oyster Festival",
        visitorFacts: { accessibility: { excerpt: PEMAQUID_ACCESS }, parking: null, pets: null },
      },
      matchType: "venue_date",
      path: "single-high",
      inboundEmailId: null,
      fromAddress: null,
    });
    expect(out.outcome).toBe("proposed");
    const row = lastAction();
    expect(row.action).toBe(ENRICH_PROPOSED_ACTION);
    expect(row.payload.proposals).toMatchObject({
      accessibility_notes: { value: PEMAQUID_ACCESS, excerpt: PEMAQUID_ACCESS },
    });
    // The citation's source_url travels as the payload's `source`.
    expect(row.payload.source).toBe("https://pemaquidoysterfestival.com/");
    expect(eventRow("pq")).toEqual(before);
  });

  it("pets: stages the stated rule against an UNSET event; NOT_PUBLISHED is an answer, so it's unstaged", async () => {
    const facts = {
      parking: { excerpt: ZOO_PARKING },
      accessibility: null,
      pets: { value: "NO", excerpt: ZOO_PETS },
    };
    seedEvent("unset");
    await stageEnrichOnMatch(db(), {
      existingEventId: "unset",
      url: "https://www.zoonewengland.org/zoolights/",
      event: { name: "ZooLights", visitorFacts: facts },
      matchType: "exact_url",
      path: "single-high",
      inboundEmailId: null,
      fromAddress: null,
    });
    expect(lastAction().payload.proposals).toEqual({
      source_url: "https://www.zoonewengland.org/zoolights/",
      parking_notes: { value: ZOO_PARKING, excerpt: ZOO_PARKING },
      pet_friendly: { value: "NO", excerpt: ZOO_PETS },
    });

    seedEvent("np", { pet_friendly: "NOT_PUBLISHED", parking_notes: "Park in the main lot." });
    await stageEnrichOnMatch(db(), {
      existingEventId: "np",
      url: "",
      event: { name: "ZooLights", visitorFacts: facts },
      matchType: "exact_url",
      path: "single-high",
      inboundEmailId: null,
      fromAddress: null,
    });
    const row = lastAction();
    expect(row.action).toBe(ENRICH_NOTHING_STAGED_ACTION);
    // Fill-empty: neither populated field is proposed — both are reported.
    expect((row.payload.unstagedFields as string[]).sort()).toEqual([
      "parking_notes",
      "pet_friendly",
    ]);
  });
});

describe("incomingFromExtracted — malformed visitorFacts read as absent, never guessed", () => {
  it.each([
    ["no visitorFacts", undefined],
    ["a pet sentence with no YES/NO", { pets: { excerpt: ZOO_PETS, value: null } }],
    ["a pet value outside YES/NO", { pets: { excerpt: ZOO_PETS, value: "MAYBE" } }],
    ["a value with no excerpt", { parking: { excerpt: "   " }, pets: { value: "NO" } }],
    ["not an object", "parking is free"],
  ])("%s", (_l, visitorFacts) => {
    const incoming = incomingFromExtracted(null, { visitorFacts });
    expect(incoming.parkingNotes).toBeNull();
    expect(incoming.accessibilityNotes).toBeNull();
    expect(incoming.petFriendly).toBeNull();
    expect(computeEnrichDisposition({}, incoming).extractedFields).toEqual([]);
  });
});
