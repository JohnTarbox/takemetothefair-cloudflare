/**
 * OPE-113 PR#2 — main-app alias/merge orchestration (mirrors the mcp tools).
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import type { Database as AppDb } from "../../db";
import { aliasPerformer, mergePerformer } from "../manage";

const SCHEMA_SQL = `
  CREATE TABLE performers (
    id TEXT PRIMARY KEY, user_id TEXT, name TEXT NOT NULL, slug TEXT NOT NULL,
    performer_type TEXT, act_category TEXT, description TEXT, website TEXT,
    social_links TEXT, image_url TEXT, image_focal_x REAL DEFAULT 0.5 NOT NULL,
    image_focal_y REAL DEFAULT 0.5 NOT NULL, home_base_city TEXT, home_base_state TEXT,
    contact_name TEXT, contact_email TEXT, contact_phone TEXT,
    verified INTEGER DEFAULT 0 NOT NULL, verified_pro INTEGER DEFAULT 0 NOT NULL,
    verified_pro_at INTEGER, verified_pro_by TEXT, claimed INTEGER DEFAULT 0 NOT NULL,
    claimed_at INTEGER, claimed_by TEXT, enhanced_profile INTEGER DEFAULT 0 NOT NULL,
    enhanced_profile_started_at INTEGER, enhanced_profile_expires_at INTEGER,
    enrichment_source TEXT, enrichment_attempted_at INTEGER, domain_hijacked INTEGER DEFAULT 0 NOT NULL,
    completeness_score INTEGER DEFAULT 0 NOT NULL, redirect_to_performer_id TEXT,
    alias_of_performer_id TEXT, view_count INTEGER DEFAULT 0 NOT NULL, deleted_at INTEGER,
    created_at INTEGER, updated_at INTEGER
  );
  CREATE TABLE event_performers (
    id TEXT PRIMARY KEY, event_id TEXT NOT NULL, performer_id TEXT NOT NULL,
    event_day_id TEXT, performance_start INTEGER, performance_end INTEGER, stage TEXT,
    billing TEXT, status TEXT NOT NULL DEFAULT 'PENDING', source_url TEXT, notes TEXT,
    created_at INTEGER, updated_at INTEGER
  );
  CREATE TABLE performer_slug_history (
    id TEXT PRIMARY KEY, performer_id TEXT NOT NULL, old_slug TEXT NOT NULL,
    new_slug TEXT NOT NULL, changed_at INTEGER NOT NULL, changed_by TEXT
  );
`;

let raw: InstanceType<typeof Database>;
let db: AppDb;

function perf(id: string, name: string, extra: Record<string, unknown> = {}) {
  const cols = ["id", "name", "slug", ...Object.keys(extra)];
  const vals = [id, name, name.toLowerCase().split(" ").join("-"), ...Object.values(extra)];
  raw
    .prepare(`INSERT INTO performers (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .run(...vals);
}
function appr(id: string, performerId: string, start: number | null) {
  raw
    .prepare(
      `INSERT INTO event_performers (id, event_id, performer_id, event_day_id, performance_start, status) VALUES (?, 'e1', ?, 'd1', ?, 'CONFIRMED')`
    )
    .run(id, performerId, start);
}

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema }) as unknown as AppDb;
});

describe("aliasPerformer (OPE-113)", () => {
  it("tombstones the alias + writes slug history", async () => {
    perf("canon", "Canonical");
    perf("dup", "Canonical Dup");
    const r = await aliasPerformer(db, "dup", "canon", "u1");
    expect(r.ok).toBe(true);
    const row = raw.prepare("SELECT * FROM performers WHERE id='dup'").get() as Record<
      string,
      unknown
    >;
    expect(row.alias_of_performer_id).toBe("canon");
    expect(row.deleted_at).not.toBeNull();
    expect(row.slug).not.toBe("canonical-dup");
    // slug-history maps the alias's ORIGINAL slug → the live CANONICAL slug so the
    // middleware 301s old links to the canonical page (not the tombstone).
    const hist = raw
      .prepare("SELECT old_slug, new_slug FROM performer_slug_history")
      .all() as Array<{ old_slug: string; new_slug: string }>;
    expect(hist).toEqual([{ old_slug: "canonical-dup", new_slug: "canonical" }]);
  });

  it("refuses self-alias", async () => {
    perf("x", "X");
    expect(await aliasPerformer(db, "x", "x", null)).toEqual({ ok: false, error: "self_alias" });
  });
});

describe("mergePerformer (OPE-113)", () => {
  it("moves appearances, drops keeper-clashes, gap-fills, tombstones the duplicate", async () => {
    perf("keeper", "Keeper", { website: null });
    perf("dup", "Dup", { website: "https://dup.example" });
    appr("k1", "keeper", 100); // keeper slot
    appr("d1", "dup", 100); // clashes with keeper → dropped
    appr("d2", "dup", 200); // unique → moved

    const r = await mergePerformer(db, "keeper", "dup", "u1");
    expect(r).toMatchObject({ ok: true, moved: 1, dropped: 1 });
    const keeperAppr = raw
      .prepare("SELECT COUNT(*) c FROM event_performers WHERE performer_id='keeper'")
      .get() as { c: number };
    expect(keeperAppr.c).toBe(2);
    const dupRow = raw.prepare("SELECT * FROM performers WHERE id='dup'").get() as Record<
      string,
      unknown
    >;
    expect(dupRow.deleted_at).not.toBeNull();
    expect(dupRow.redirect_to_performer_id).toBe("keeper");
    // gap-fill: keeper's empty website filled from dup.
    const keeperRow = raw.prepare("SELECT website FROM performers WHERE id='keeper'").get() as {
      website: string;
    };
    expect(keeperRow.website).toBe("https://dup.example");
    // slug-history maps dup's ORIGINAL slug → the live KEEPER slug (301 target).
    const hist = raw
      .prepare("SELECT old_slug, new_slug FROM performer_slug_history")
      .all() as Array<{ old_slug: string; new_slug: string }>;
    expect(hist).toEqual([{ old_slug: "dup", new_slug: "keeper" }]);
  });

  it("refuses self-merge", async () => {
    perf("x", "X");
    expect(await mergePerformer(db, "x", "x", null)).toEqual({ ok: false, error: "self_merge" });
  });
});
