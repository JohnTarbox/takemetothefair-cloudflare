/**
 * OPE-1352 — `repointInboundEmailsToKeeper` (packages/db-schema), against real
 * SQLite, plus the heartbeat probe that watches its invariant.
 *
 * The specimen is prod's: inbound f8ef71e5 still named the rejected duplicate
 * e15e22a7 instead of the keeper 7b8ac15d (UMF Chester Greenwood craft fair).
 * The wiring into all three adjudication writers is tested where each lives:
 * flag-queue-ope1117.test.ts, merge-series-slug-collision-ope793.test.ts and
 * mcp-server/__tests__/inbound-repoint-on-duplicate-reject-ope1352.test.ts.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/lib/db/schema";
import {
  INBOUND_REPOINT_ACTION,
  MAX_KEEPER_HOPS,
  repointInboundEmailsToKeeper,
  resolveLiveKeeper,
} from "@takemetothefair/db-schema";
import { HEARTBEAT_PROBES } from "@/lib/heartbeat";

const LOSER = "e15e22a7-83f4-4ddb-adb8-f563ca2d4bc9";
const KEEPER = "7b8ac15d-8d86-41c7-b4ca-a17a1e58cb72";
const INBOUND = "f8ef71e5-3ee4-4fc5-b6fa-1e58b18e7705";

let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(`
    CREATE TABLE events (id TEXT PRIMARY KEY, merged_into TEXT, rejected_as_duplicate_of TEXT, updated_at INTEGER);
    CREATE TABLE inbound_emails (id TEXT PRIMARY KEY, resulting_event_id TEXT);
    CREATE TABLE admin_actions (id TEXT PRIMARY KEY, action TEXT NOT NULL, actor_user_id TEXT,
      target_type TEXT NOT NULL, target_id TEXT NOT NULL, payload_json TEXT, created_at INTEGER NOT NULL);
  `);
  db = drizzle(raw, { schema });
});

const ev = (id: string, o: { merged?: string; rejDup?: string; updated?: number } = {}) =>
  raw
    .prepare(`INSERT INTO events VALUES (?,?,?,?)`)
    .run(id, o.merged ?? null, o.rejDup ?? null, o.updated ?? 1_760_000_000);
const inbound = (id: string, eventId: string | null) =>
  raw.prepare(`INSERT INTO inbound_emails VALUES (?,?)`).run(id, eventId);
const ptr = (id: string) =>
  (
    raw.prepare(`SELECT resulting_event_id AS r FROM inbound_emails WHERE id = ?`).get(id) as {
      r: string | null;
    }
  ).r;
const audits = () =>
  (
    raw
      .prepare(
        `SELECT target_id, payload_json FROM admin_actions WHERE action = ? ORDER BY target_id`
      )
      .all(INBOUND_REPOINT_ACTION) as Array<{ target_id: string; payload_json: string }>
  ).map((a) => ({ id: a.target_id, ...JSON.parse(a.payload_json) }));

const run = (loserId: string, keeperId: string) =>
  repointInboundEmailsToKeeper(db as never, {
    loserId,
    keeperId,
    reason: "rejected_as_duplicate_of",
    actorUserId: "admin-1",
  });

describe("repointInboundEmailsToKeeper — the Chester Greenwood specimen", () => {
  it("moves the inbound off the rejected duplicate onto the keeper, and audits the original", async () => {
    ev(KEEPER);
    ev(LOSER, { rejDup: KEEPER });
    inbound(INBOUND, LOSER);
    inbound("unrelated", KEEPER);

    const r = await run(LOSER, KEEPER);
    expect(r).toEqual({ keeperId: KEEPER, repointed: [INBOUND] });
    expect(ptr(INBOUND)).toBe(KEEPER);
    expect(ptr("unrelated")).toBe(KEEPER);
    expect(audits()).toEqual([
      {
        id: INBOUND,
        from_event_id: LOSER,
        to_event_id: KEEPER,
        named_keeper_id: KEEPER,
        reason: "rejected_as_duplicate_of",
      },
    ]);
  });

  it("is idempotent — a second call finds nothing on the loser and writes nothing", async () => {
    ev(KEEPER);
    ev(LOSER, { rejDup: KEEPER });
    inbound(INBOUND, LOSER);
    await run(LOSER, KEEPER);
    expect(await run(LOSER, KEEPER)).toEqual({ keeperId: null, repointed: [] });
    expect(audits()).toHaveLength(1);
  });
});

describe("chains — the inbound lands on the LIVE keeper", () => {
  it("follows a keeper that was itself merged, and a merge beats a reject on the same row", async () => {
    ev("K-final");
    ev("K-mid", { merged: "K-final", rejDup: "elsewhere" });
    ev(LOSER, { rejDup: "K-mid" });
    inbound(INBOUND, LOSER);
    const r = await run(LOSER, "K-mid");
    expect(r.keeperId).toBe("K-final");
    expect(ptr(INBOUND)).toBe("K-final");
    expect(audits()[0]).toMatchObject({ to_event_id: "K-final", named_keeper_id: "K-mid" });
  });

  it("leaves the pointer alone when the chain cycles", async () => {
    ev("A", { rejDup: "B" });
    ev("B", { rejDup: "A" });
    ev(LOSER, { rejDup: "A" });
    inbound(INBOUND, LOSER);
    expect(await resolveLiveKeeper(db as never, "A")).toBeNull();
    expect(await run(LOSER, "A")).toEqual({ keeperId: null, repointed: [] });
    expect(ptr(INBOUND)).toBe(LOSER);
    expect(audits()).toEqual([]);
  });

  it("leaves the pointer alone when the chain leads back to the loser", async () => {
    ev("K", { rejDup: LOSER });
    ev(LOSER, { rejDup: "K" });
    inbound(INBOUND, LOSER);
    expect((await run(LOSER, "K")).repointed).toEqual([]);
    expect(ptr(INBOUND)).toBe(LOSER);
  });

  it("leaves the pointer alone when the named keeper does not exist", async () => {
    ev(LOSER, { rejDup: "ghost" });
    inbound(INBOUND, LOSER);
    expect((await run(LOSER, "ghost")).repointed).toEqual([]);
    expect(ptr(INBOUND)).toBe(LOSER);
  });

  it(`refuses a chain longer than ${MAX_KEEPER_HOPS} hops, follows one at the cap`, async () => {
    // k0 → k1 → … → kN ; resolving from k0 takes N hops.
    const N = MAX_KEEPER_HOPS;
    for (let i = 0; i < N; i++) ev(`k${i}`, { merged: `k${i + 1}` });
    ev(`k${N}`);
    expect(await resolveLiveKeeper(db as never, "k0")).toBe(`k${N}`);
    raw.prepare(`UPDATE events SET merged_into = 'k${N + 1}' WHERE id = 'k${N}'`).run();
    ev(`k${N + 1}`);
    expect(await resolveLiveKeeper(db as never, "k0")).toBeNull();
  });
});

describe("volume — D1's 100-parameter cap", () => {
  it("repoints and audits 130 inbound rows on one loser", async () => {
    ev(KEEPER);
    ev(LOSER, { rejDup: KEEPER });
    for (let i = 0; i < 130; i++) inbound(`in-${String(i).padStart(3, "0")}`, LOSER);
    const r = await run(LOSER, KEEPER);
    expect(r.repointed).toHaveLength(130);
    expect(
      raw
        .prepare(`SELECT count(*) AS n FROM inbound_emails WHERE resulting_event_id = ?`)
        .get(KEEPER)
    ).toEqual({ n: 130 });
    expect(audits()).toHaveLength(130);
  });
});

describe("heartbeat probe — inbound-follows-duplicate-keeper", () => {
  const probe = HEARTBEAT_PROBES.find((p) => p.name === "inbound-follows-duplicate-keeper")!;

  it("reads healthy NOW when no inbound names a loser", async () => {
    ev(KEEPER);
    ev(LOSER, { rejDup: KEEPER, updated: 1_700_000_000 });
    inbound(INBOUND, KEEPER);
    const t = await probe.lastEvidenceAt(db as never);
    expect(Date.now() - (t as Date).getTime()).toBeLessThan(60_000);
  });

  it("starts the clock at the loser's adjudication when an inbound is left on it", async () => {
    ev(KEEPER);
    ev(LOSER, { rejDup: KEEPER, updated: 1_700_000_000 });
    ev("M", { merged: KEEPER, updated: 1_750_000_000 });
    inbound(INBOUND, LOSER);
    inbound("in-m", "M");
    expect(await probe.lastEvidenceAt(db as never)).toEqual(new Date(1_700_000_000_000));
  });
});
