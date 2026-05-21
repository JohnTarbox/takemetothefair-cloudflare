/**
 * Integration tests for autoLinkVenue.
 *
 * Spun up against an in-memory better-sqlite3 with a minimal venues +
 * admin_actions schema — enough for the matcher's SELECT/INSERT shape.
 * This is the first main-app test that runs against a real DB instance;
 * if more tests need this pattern, factor out a shared setup-db helper
 * (the mcp-server side already has one at mcp-server/__tests__/setup-db.ts).
 *
 * The PR-C fuzzy tier (Levenshtein-backed) is the focus. Pre-PR behavior
 * (exact-only tiers 1+2 and address-only tier 4) is also exercised so the
 * tests double as a regression guard.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import { autoLinkVenue } from "../venue-matching";

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

const SCHEMA_SQL = `
  CREATE TABLE venues (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    address TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT '',
    zip TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'ACTIVE'
  );
  CREATE TABLE admin_actions (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    actor_user_id TEXT,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    payload_json TEXT,
    created_at INTEGER NOT NULL
  );
`;

let raw: Database.Database;
let db: TestDb;

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

afterEach(() => {
  raw.close();
});

function insertVenue(opts: { id: string; name: string; state?: string; address?: string }): void {
  raw
    .prepare(
      "INSERT INTO venues (id, name, slug, address, city, state, zip, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE')"
    )
    .run(
      opts.id,
      opts.name,
      opts.id, // slug doesn't matter for these tests
      opts.address ?? "",
      "",
      opts.state ?? "",
      ""
    );
}

// Cast our better-sqlite3 Drizzle to the D1-typed one autoLinkVenue
// expects — they're structurally compatible for the SELECT/INSERT shape
// used by the matcher.
type AutoLinkDb = Parameters<typeof autoLinkVenue>[0];
const asDb = (d: TestDb): AutoLinkDb => d as unknown as AutoLinkDb;

describe("autoLinkVenue — exact-name path (pre-PR-C behavior, regression guard)", () => {
  it("links when exactly one venue exact-matches normalized name", async () => {
    insertVenue({ id: "v-1", name: "Downtown Farmington", state: "ME" });
    const result = await autoLinkVenue(asDb(db), {
      venueName: "Downtown Farmington",
      venueState: "ME",
    });
    expect(result.venueId).toBe("v-1");
    expect(result.decision).toBe("exact-name+state");
    expect(result.stateCode).toBe("ME");
  });

  it("does NOT link 'Downtown Farmington' against 'Downtown Bangor' (different exact name)", async () => {
    insertVenue({ id: "v-bangor", name: "Downtown Bangor", state: "ME" });
    const result = await autoLinkVenue(asDb(db), {
      venueName: "Downtown Farmington",
      venueState: "ME",
    });
    // Neither exact-match nor fuzzy ≥0.85 — too different (Farmington vs
    // Bangor share no characters past the first letter).
    expect(result.venueId).toBeNull();
    expect(result.decision).toBe("no-match");
  });
});

describe("autoLinkVenue — Tier 3 fuzzy (PR-C)", () => {
  it("links reordered name 'Farmington Downtown' to 'Downtown Farmington' (state matches)", async () => {
    insertVenue({ id: "v-1", name: "Downtown Farmington", state: "ME" });
    const result = await autoLinkVenue(asDb(db), {
      venueName: "Farmington Downtown",
      venueState: "ME",
    });
    // Levenshtein on normalized strings: "downtown farmington" vs
    // "farmington downtown" share most chars; similarity is high enough
    // to clear the 0.85 floor.
    expect(result.venueId).toBe("v-1");
    expect(result.decision).toBe("fuzzy-name+state");
    expect(result.stateCode).toBe("ME");
  });

  it("rejects fuzzy match when state disagrees", async () => {
    // Same fuzzy similarity but candidate is in MA, input says NH —
    // cross-state fuzzy is dangerous, the matcher must skip it.
    insertVenue({ id: "v-ma", name: "Downtown Farmington", state: "MA" });
    const result = await autoLinkVenue(asDb(db), {
      venueName: "Farmington Downtown",
      venueState: "NH",
    });
    expect(result.venueId).toBeNull();
    expect(result.decision).toBe("no-match");
  });

  it("returns ambiguous + writes admin_actions when 2+ exact-normalized matches in same state", async () => {
    // Two real venues both literally named "Town Hall" in the same state.
    // Matcher must NOT silently pick one — surfaces to admin via the new
    // venue.ambiguous_match audit row.
    insertVenue({ id: "v-a", name: "Town Hall", state: "MA", address: "1 Main St" });
    insertVenue({ id: "v-b", name: "Town Hall", state: "MA", address: "5 Elm St" });
    const result = await autoLinkVenue(asDb(db), {
      venueName: "Town Hall",
      venueState: "MA",
    });
    expect(result.venueId).toBeNull();
    expect(result.decision).toBe("ambiguous");
    expect(result.candidates?.length).toBe(2);

    const auditRows = raw
      .prepare("SELECT action, target_type, payload_json FROM admin_actions")
      .all() as { action: string; target_type: string; payload_json: string }[];
    expect(auditRows.length).toBe(1);
    expect(auditRows[0].action).toBe("venue.ambiguous_match");
    expect(auditRows[0].target_type).toBe("venue");
    const payload = JSON.parse(auditRows[0].payload_json);
    expect(payload.tier).toBe("exact");
    expect(payload.candidates.length).toBe(2);
  });

  it("returns ambiguous when 2+ same-bag candidates exist in same state (reorderings of identical token-set)", async () => {
    // Both candidates have the same token set as the input — without
    // explicit ambiguity handling the matcher would silently pick one.
    insertVenue({ id: "v-a", name: "Marlboro Town Hall", state: "MA" });
    insertVenue({ id: "v-b", name: "Town Hall Marlboro", state: "MA" });
    const result = await autoLinkVenue(asDb(db), {
      venueName: "Marlboro Hall Town",
      venueState: "MA",
    });
    expect(result.venueId).toBeNull();
    expect(result.decision).toBe("ambiguous");
    expect(result.candidates?.length).toBe(2);

    const auditRows = raw
      .prepare("SELECT action, target_type, payload_json FROM admin_actions")
      .all() as { action: string; target_type: string; payload_json: string }[];
    expect(auditRows.length).toBe(1);
    const payload = JSON.parse(auditRows[0].payload_json);
    expect(payload.tier).toBe("fuzzy");
  });

  it("links via fuzzy+address corroboration when name is paraphrased but address tokens overlap", async () => {
    insertVenue({
      id: "v-1",
      name: "Downtown Farmington Office",
      state: "ME",
      address: "120 Broadway",
    });
    const result = await autoLinkVenue(asDb(db), {
      venueName: "Downtown Farmington", // 0.7-ish similarity to candidate
      venueAddress: "120 Broadway",
      venueState: "ME",
    });
    // High-confidence in-state path may or may not trigger depending on
    // exact Levenshtein, but address-token corroboration should clinch it
    // either way — single confident match.
    expect(result.venueId).toBe("v-1");
    expect(result.stateCode).toBe("ME");
  });

  it("does NOT pick 'Sterling Hall' when input is 'Starling Hall' and they're in different states", async () => {
    insertVenue({ id: "v-1", name: "Sterling Hall", state: "VT" });
    const result = await autoLinkVenue(asDb(db), {
      venueName: "Starling Hall",
      venueState: "MA",
    });
    expect(result.venueId).toBeNull();
    expect(result.decision).toBe("no-match");
  });
});

describe("autoLinkVenue — null/empty input", () => {
  it("returns no-name when venueName is null", async () => {
    const result = await autoLinkVenue(asDb(db), { venueName: null });
    expect(result.venueId).toBeNull();
    expect(result.decision).toBe("no-name");
  });

  it("returns no-match when no candidates at all", async () => {
    const result = await autoLinkVenue(asDb(db), {
      venueName: "Nonexistent Place",
      venueState: "ME",
    });
    expect(result.venueId).toBeNull();
    expect(result.decision).toBe("no-match");
  });
});
