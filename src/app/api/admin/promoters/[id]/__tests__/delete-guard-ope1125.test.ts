/**
 * OPE-1125 — DELETE /api/admin/promoters/[id] refuses while the promoter owns
 * events, and a permitted delete leaves nothing orphaned.
 *
 * `events.promoter_id` is ON DELETE CASCADE, so the old route deleted every
 * event a promoter owned — silently, unaudited. Driven both ways as the
 * acceptance requires: refused WITH events (nothing changes, not even the
 * owner's role), permitted WITHOUT (audited, children cleared).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "@/lib/db/schema";

let raw: InstanceType<typeof Database>;
let db: ReturnType<typeof drizzle<typeof schema>>;

vi.mock("@/lib/auth", () => ({
  auth: async () => ({ user: { id: "admin-1", role: "ADMIN" } }),
  hasRole: (s: { user?: { role?: string } } | null, r: string) => s?.user?.role === r,
}));
vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: () => db,
  getCloudflareEnv: () => ({}),
}));
vi.mock("@/lib/logger", () => ({ logError: vi.fn(async () => {}) }));

const { DELETE } = await import("../route");

/**
 * Every column of the real Drizzle table, no constraints: the route selects
 * whole rows, so a hand-written subset would fail on the first unlisted column.
 */
function looseTable(t: SQLiteTable) {
  const cfg = getTableConfig(t);
  raw.exec(`CREATE TABLE ${cfg.name} (${cfg.columns.map((c) => `"${c.name}"`).join(", ")})`);
}

const count = (q: string) => (raw.prepare(q).get() as { n: number }).n;
const del = (id: string) =>
  DELETE(new NextRequest(`http://localhost/api/admin/promoters/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });

beforeEach(() => {
  raw = new Database(":memory:");
  db = drizzle(raw, { schema });
  for (const t of [
    schema.promoters,
    schema.events,
    schema.users,
    schema.adminActions,
    schema.promoterEnrichmentCandidates,
    schema.pendingSearchPings,
    schema.imageCoverageState,
  ])
    looseTable(t as SQLiteTable);

  raw.exec(`
    INSERT INTO users (id, email, role) VALUES ('u-owner', 'o@x.com', 'PROMOTER');
    INSERT INTO promoters (id, company_name, slug, user_id) VALUES ('p-busy', 'Busy', 'busy', 'u-owner');
    INSERT INTO promoters (id, company_name, slug, user_id) VALUES ('p-empty', 'Empty', 'empty', 'u-owner');
    INSERT INTO events (id, name, slug, promoter_id) VALUES ('e1', 'Fair', 'fair', 'p-busy');
    INSERT INTO events (id, name, slug, promoter_id) VALUES ('e2', 'Fair 2', 'fair-2', 'p-busy');
    INSERT INTO promoter_enrichment_candidates (id, promoter_id, proposed_field, decision)
      VALUES (1, 'p-empty', 'logo', 'pending');
    INSERT INTO pending_search_pings (id, entity_type, entity_id, entity_slug)
      VALUES ('ping', 'promoter', 'p-empty', 'empty');
    INSERT INTO image_coverage_state (entity_type, entity_id, slug)
      VALUES ('PROMOTER', 'p-empty', 'empty');
  `);
});

describe("OPE-1125 — DELETE a promoter", () => {
  it("REFUSES while it owns events: 409, and nothing changes — not even the owner's role", async () => {
    const res = await del("p-busy");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; eventCount: number };
    expect(body).toMatchObject({ error: "promoter_has_events", eventCount: 2 });

    expect(count(`SELECT count(*) n FROM promoters WHERE id='p-busy'`)).toBe(1);
    expect(count(`SELECT count(*) n FROM events WHERE promoter_id='p-busy'`)).toBe(2);
    expect(
      (raw.prepare(`SELECT role FROM users WHERE id='u-owner'`).get() as { role: string }).role
    ).toBe("PROMOTER");
    expect(count(`SELECT count(*) n FROM admin_actions`)).toBe(0);
  });

  it("PERMITS a promoter with no events: deleted, audited, and no orphans left", async () => {
    // Landmark: the promoter really had FK-less children to clear.
    expect(
      count(`SELECT count(*) n FROM promoter_enrichment_candidates WHERE promoter_id='p-empty'`)
    ).toBe(1);

    const res = await del("p-empty");
    expect(res.status).toBe(200);

    expect(count(`SELECT count(*) n FROM promoters WHERE id='p-empty'`)).toBe(0);
    // The OPE-1120 orphan queries.
    expect(
      count(
        `SELECT count(*) n FROM promoter_enrichment_candidates c WHERE NOT EXISTS (SELECT 1 FROM promoters p WHERE p.id=c.promoter_id)`
      )
    ).toBe(0);
    expect(
      count(
        `SELECT count(*) n FROM pending_search_pings s WHERE lower(s.entity_type)='promoter' AND NOT EXISTS (SELECT 1 FROM promoters p WHERE p.id=s.entity_id)`
      )
    ).toBe(0);
    expect(
      count(
        `SELECT count(*) n FROM image_coverage_state s WHERE lower(s.entity_type)='promoter' AND NOT EXISTS (SELECT 1 FROM promoters p WHERE p.id=s.entity_id)`
      )
    ).toBe(0);

    const audit = raw.prepare(`SELECT action, target_id FROM admin_actions`).all();
    expect(audit).toEqual([{ action: "promoter.delete", target_id: "p-empty" }]);
  });
});
