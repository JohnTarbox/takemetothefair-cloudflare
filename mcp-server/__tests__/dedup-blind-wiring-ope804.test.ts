/**
 * OPE-804, the wiring half — a blind dedup verdict must leave a trace.
 *
 * The predicate half lives in `src/lib/duplicates/__tests__/
 * dedup-blind-visibility.test.ts` and proves `findDuplicate` can now SAY it
 * compared nothing. That alone changes no behaviour: OPE-477 shipped exactly
 * that much and the CraftFest Cotuit duplicate was created two months later,
 * because the report had no reader.
 *
 * So this file asserts the reader. Every event this workflow creates goes
 * through `submitEvent`, and `submitEvent` now REQUIRES the dedup verdict that
 * permitted it. When that verdict was blind, two rows are written:
 *
 *   admin_actions(action='dedup.blind')   the durable, queryable trail
 *   inbound_emails.flagged_for_review = 1 the queue a person actually opens
 *
 * ⚠️ The assertion that matters most is the NEGATIVE one at the bottom: with
 * `dedupWasBlind: false` nothing is written. A recorder that fires on every
 * submission would bury the real cases in the same queue, which is the
 * OPE-477 outcome by a different route.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../src/schema.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;

// `submitEvent` reaches D1 through getDb(env.DB). The test DB is better-sqlite3,
// so getDb is redirected rather than faking a D1Database surface.
vi.mock("../src/db.js", () => ({
  getDb: () => db,
}));
vi.mock("../src/logger.js", () => ({
  logError: vi.fn(async () => {}),
}));

import { submitEvent } from "../src/email-handlers/submit.js";
import type { HandlerEnv } from "../src/email-handlers/types.js";

const SCHEMA_SQL = `
  CREATE TABLE admin_actions (
    id TEXT PRIMARY KEY, action TEXT NOT NULL, actor_user_id TEXT,
    target_type TEXT, target_id TEXT, payload_json TEXT, created_at INTEGER
  );
  CREATE TABLE inbound_emails (
    id TEXT PRIMARY KEY, from_address TEXT, flagged_for_review INTEGER DEFAULT 0
  );
`;

const ENV: HandlerEnv = {
  DB: {} as unknown as D1Database,
  MAIN_APP_URL: "https://example.com",
  INTERNAL_API_KEY: "test-key",
};

const EXTRACTED = {
  url: "",
  event: { name: "CraftFest Cotuit 2026", startDate: undefined },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  db = drizzle(raw, { schema });
  raw
    .prepare(`INSERT INTO inbound_emails (id,from_address,flagged_for_review) VALUES (?,?,?)`)
    .run("email-1", "organizer@example.com", 0);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ success: true, event: { id: "ev-1", slug: "craftfest" } }))
  );
});

const rowsFor = (action: string) =>
  raw.prepare(`SELECT * FROM admin_actions WHERE action = ?`).all(action) as Array<{
    target_id: string;
    payload_json: string;
  }>;
const flagOf = (id: string) =>
  (
    raw.prepare(`SELECT flagged_for_review AS f FROM inbound_emails WHERE id = ?`).get(id) as {
      f: number;
    }
  ).f;

describe("a blind verdict leaves a trace", () => {
  it("writes dedup.blind and flags the inbound row", async () => {
    // Positive landmark: the flag starts DOWN. Without this the assertion
    // below passes against a fixture that was always 1.
    expect(flagOf("email-1")).toBe(0);
    expect(rowsFor("dedup.blind")).toHaveLength(0);

    const created = await submitEvent(ENV, EXTRACTED, "organizer@example.com", {
      inboundEmailId: "email-1",
      dedupWasBlind: true,
    });

    expect(created.id).toBe("ev-1");
    const rows = rowsFor("dedup.blind");
    expect(rows).toHaveLength(1);
    expect(rows[0].target_id).toBe("ev-1");
    // The two facts that made the check impossible, recorded so a reviewer
    // does not have to re-derive them from a row that looks clean.
    const payload = JSON.parse(rows[0].payload_json);
    expect(payload.inboundEmailId).toBe("email-1");
    expect(payload.hadSourceUrl).toBe(false);
    expect(flagOf("email-1")).toBe(1);
  });

  it("returns the created event unchanged — annotation is additive", async () => {
    const created = await submitEvent(ENV, EXTRACTED, "organizer@example.com", {
      inboundEmailId: "email-1",
      dedupWasBlind: true,
    });
    expect(created).toEqual({
      id: "ev-1",
      slug: "craftfest",
      eventName: "CraftFest Cotuit 2026",
    });
  });

  it("never throws when the annotation write fails — the event already exists", async () => {
    // The event is in the database by the time we annotate. Throwing here
    // would make the workflow retry a create that already happened.
    raw["exec"](`DROP TABLE admin_actions`);
    const created = await submitEvent(ENV, EXTRACTED, "organizer@example.com", {
      inboundEmailId: "email-1",
      dedupWasBlind: true,
    });
    expect(created.id).toBe("ev-1");
  });
});

describe("a verdict that was actually reached writes nothing", () => {
  it("dedupWasBlind:false leaves no admin_actions row and no flag", async () => {
    await submitEvent(ENV, EXTRACTED, "organizer@example.com", {
      inboundEmailId: "email-1",
      dedupWasBlind: false,
    });
    // The negative assertion, with the landmark that makes it mean something:
    // the previous describe block proves this table and flag DO move when the
    // verdict is blind, so an empty result here is a decision, not an inert
    // recorder.
    expect(rowsFor("dedup.blind")).toHaveLength(0);
    expect(flagOf("email-1")).toBe(0);
  });
});
