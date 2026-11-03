/**
 * OPE-1152 — the enrich-on-match probe, and the review-surface parser.
 *
 * The stager writes one admin_actions row per match. The probe owes evidence
 * only when there was demand (an `already-exists` reply — the single-event HIGH
 * branch always stages before it replies), so a week with no matches is not a
 * false RED, and a match that leaves no disposition row is.
 *
 * Amendment H: every case states the row counts it read before trusting the
 * verdict — an empty table satisfies "no evidence" for the wrong reason.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import { HEARTBEAT_PROBES } from "@/lib/heartbeat";
import {
  ENRICH_NOTHING_STAGED_ACTION,
  ENRICH_PROPOSED_ACTION,
  parseEnrichOnMatchRow,
} from "@/lib/inbound-enrich-on-match";

const SCHEMA_SQL = `
  CREATE TABLE admin_actions (
    id TEXT PRIMARY KEY, action TEXT NOT NULL, actor_user_id TEXT,
    target_type TEXT NOT NULL, target_id TEXT NOT NULL, payload_json TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE inbound_emails (
    id TEXT PRIMARY KEY, received_at INTEGER NOT NULL, reply_kind TEXT
  );
  CREATE TABLE heartbeat_probes (
    probe_name TEXT PRIMARY KEY, enabled_at INTEGER, updated_at INTEGER
  );
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;
const T = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const probe = HEARTBEAT_PROBES.find((p) => p.name === "enrich-on-match-disposition")!;

const seedReply = (id: string, at: string, kind: string) =>
  raw
    .prepare(`INSERT INTO inbound_emails (id, received_at, reply_kind) VALUES (?, ?, ?)`)
    .run(id, T(at), kind);
const seedAction = (id: string, action: string, at: string) =>
  raw
    .prepare(
      `INSERT INTO admin_actions (id, action, target_type, target_id, payload_json, created_at) VALUES (?, ?, 'event', 'e1', '{}', ?)`
    )
    .run(id, action, T(at));
const count = (table: string) =>
  (raw.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  // Armed before every specimen below, as migration 0368 arms it at ship time.
  raw
    .prepare(`INSERT INTO heartbeat_probes (probe_name, enabled_at) VALUES (?, ?)`)
    .run("enrich-on-match-disposition", T("2026-10-05T00:00:00Z"));
  db = drizzle(raw, { schema });
});

const isNow = (d: Date | null) => d !== null && Math.abs(d.getTime() - Date.now()) < 60_000;

describe("OPE-1152 enrich-on-match-disposition probe", () => {
  it("is registered, owned, with a 72h window", () => {
    expect(probe).toBeTruthy();
    expect(probe.ownerOpe).toBe("OPE-1152");
    expect(probe.expectedWindowHours).toBe(72);
  });

  it("no match ever: healthy (no demand)", async () => {
    seedReply("i1", "2026-10-10T12:00:00Z", "ok");
    expect([count("inbound_emails"), count("admin_actions")]).toEqual([1, 0]);
    expect(isNow(await probe.lastEvidenceAt(db))).toBe(true);
  });

  it("a match answered by a disposition row (either kind) is healthy", async () => {
    seedReply("i1", "2026-10-10T12:00:00Z", "already-exists");
    seedAction("a1", ENRICH_NOTHING_STAGED_ACTION, "2026-10-10T12:00:30Z");
    expect([count("inbound_emails"), count("admin_actions")]).toEqual([1, 1]);
    expect(isNow(await probe.lastEvidenceAt(db))).toBe(true);
  });

  it("a match with NO disposition row starts the silence clock at the match — the OPE-1152 shape", async () => {
    seedReply("i1", "2026-10-10T12:00:00Z", "already-exists");
    seedAction("a0", ENRICH_PROPOSED_ACTION, "2026-08-26T03:37:47Z"); // the lifetime's one row
    seedAction("x", "dedup.would_enrich", "2026-10-11T00:00:00Z"); // not evidence
    expect([count("inbound_emails"), count("admin_actions")]).toEqual([1, 2]);
    expect((await probe.lastEvidenceAt(db))?.toISOString()).toBe("2026-10-10T12:00:00.000Z");
  });
});

describe("OPE-1152 probe — demand floored at enabled_at", () => {
  it("an already-exists reply from BEFORE the probe was armed is not demand (no false RED on ship)", async () => {
    seedReply("old", "2026-10-04T00:42:25Z", "already-exists"); // prod's newest pre-ship match
    seedAction("a0", ENRICH_PROPOSED_ACTION, "2026-08-26T03:37:47Z");
    expect([count("inbound_emails"), count("admin_actions"), count("heartbeat_probes")]).toEqual([
      1, 1, 1,
    ]);
    expect(isNow(await probe.lastEvidenceAt(db))).toBe(true);
  });

  it("a dormant/unseeded probe sees no demand", async () => {
    raw.exec(`DELETE FROM heartbeat_probes`);
    seedReply("i1", "2026-10-10T12:00:00Z", "already-exists");
    expect(count("heartbeat_probes")).toBe(0);
    expect(isNow(await probe.lastEvidenceAt(db))).toBe(true);
  });
});

describe("parseEnrichOnMatchRow", () => {
  it("reads both kinds; a malformed payload still lists", () => {
    const ok = parseEnrichOnMatchRow({
      id: "a1",
      action: ENRICH_PROPOSED_ACTION,
      targetId: "e1",
      createdAt: new Date("2026-10-10T12:00:00Z"),
      payloadJson: JSON.stringify({
        proposals: { vendor_fee_min_cents: 2000 },
        extractedFields: ["vendor_fee_min_cents", "vendor_fee_notes"],
        unstagedFields: ["vendor_fee_notes"],
        path: "possible-duplicate",
        matchType: "possible_duplicate",
      }),
      eventName: "Hackmatack",
      eventSlug: "hackmatack",
    });
    expect(ok).toMatchObject({
      outcome: "proposed",
      event: { id: "e1", name: "Hackmatack", slug: "hackmatack" },
      proposals: { vendor_fee_min_cents: 2000 },
      unstagedFields: ["vendor_fee_notes"],
      path: "possible-duplicate",
    });
    const bad = parseEnrichOnMatchRow({
      id: "a2",
      action: ENRICH_NOTHING_STAGED_ACTION,
      targetId: "e2",
      createdAt: 1790000000,
      payloadJson: "{not json",
    });
    expect(bad.outcome).toBe("nothing-staged");
    expect(bad.proposals).toEqual({});
    expect(bad.createdAt).toBe(new Date(1790000000 * 1000).toISOString());
  });
});
