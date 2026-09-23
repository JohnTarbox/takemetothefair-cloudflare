/**
 * OPE-1120 — a promoter merge leaves nothing pointing at the id it deletes.
 *
 * `merge_promoter` reassigned events and hard-deleted the loser; every table
 * that references promoters WITHOUT a declared FK kept the dead id. Measured
 * 2026-09-22: 24 enrichment candidates (20 still pending in the review queue),
 * 5 search pings, 2 image-coverage rows.
 *
 * The acceptance is the orphan query returning 0 after a merge — asserted here
 * with the ticket's own SQL, beside a landmark proving the loser HAD children.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { unsafeSlug } from "@takemetothefair/utils";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerMergeEntitiesTools } from "../src/tools/admin-merge-entities.js";
import { promoters, promoterEnrichmentCandidates } from "../src/schema.js";
import { PROMOTER_MERGE_REVIEWER } from "@takemetothefair/db-schema";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };

let db: TestDb;
let raw: ReturnType<typeof createTestDb>["raw"];
let server: CapturingMcpServer;
let mock: ReturnType<typeof mockIndexNowFetch>;

const count = (sqlText: string) => (raw.prepare(sqlText).get() as { n: number }).n;

const ORPHANS = {
  candidates: `SELECT count(*) n FROM promoter_enrichment_candidates c WHERE NOT EXISTS (SELECT 1 FROM promoters p WHERE p.id=c.promoter_id)`,
  pings: `SELECT count(*) n FROM pending_search_pings s WHERE lower(s.entity_type)='promoter' AND NOT EXISTS (SELECT 1 FROM promoters p WHERE p.id=s.entity_id)`,
  coverage: `SELECT count(*) n FROM image_coverage_state s WHERE lower(s.entity_type)='promoter' AND NOT EXISTS (SELECT 1 FROM promoters p WHERE p.id=s.entity_id)`,
};

function candidate(promoterId: string, field: string, decision = "pending", value = "x") {
  db.insert(promoterEnrichmentCandidates)
    .values({
      promoterId,
      jobRunId: "run-1",
      proposedField: field,
      proposedValue: value,
      sourceUrl: "https://example.org",
      extractionMethod: "jsonld",
      decision: decision as "pending",
      createdAt: new Date(),
    })
    .run();
}

beforeEach(() => {
  ({ db, raw } = createTestDb());
  server = new CapturingMcpServer();
  registerMergeEntitiesTools(server as never, db, ADMIN_AUTH);
  mock = mockIndexNowFetch();

  db.insert(promoters)
    .values([
      // The keeper already HAS a logo; its description is empty.
      {
        id: "keeper",
        companyName: "Keeper",
        slug: unsafeSlug("keeper"),
        logoUrl: "https://k/logo.png",
      },
      { id: "loser", companyName: "Loser", slug: unsafeSlug("loser") },
    ])
    .run();

  candidate("loser", "logo"); // keeper has one → must NOT overwrite
  candidate("loser", "description"); // keeper empty → move it
  candidate("loser", "hero", "approved"); // history → keep, repointed
  raw
    .prepare(
      `INSERT INTO pending_search_pings (id, entity_type, entity_id, entity_slug, action, queued_at)
       VALUES ('ping-1', 'promoter', 'loser', 'loser', 'update', 0)`
    )
    .run();
  raw
    .prepare(
      `INSERT INTO image_coverage_state (entity_type, entity_id, slug, first_seen_at, checked_at)
       VALUES ('PROMOTER', 'loser', 'loser', 0, 0)`
    )
    .run();
});
afterEach(() => mock.restore());

async function merge() {
  const r = (await server.invoke("merge_promoter", {
    keeper_promoter_id: "keeper",
    duplicate_promoter_id: "loser",
  })) as { isError?: boolean; content: Array<{ text: string }> };
  if (r.isError) throw new Error(r.content[0].text);
  return JSON.parse(r.content[0].text);
}

describe("merge_promoter — the rows no FK protects", () => {
  it("ACCEPTANCE: every orphan query is 0 after the merge", async () => {
    // Landmark: the loser really had children, so the zeros below are earned.
    expect(
      count(`SELECT count(*) n FROM promoter_enrichment_candidates WHERE promoter_id='loser'`)
    ).toBe(3);
    expect(count(`SELECT count(*) n FROM pending_search_pings WHERE entity_id='loser'`)).toBe(1);
    expect(count(`SELECT count(*) n FROM image_coverage_state WHERE entity_id='loser'`)).toBe(1);

    await merge();

    expect(count(`SELECT count(*) n FROM promoters WHERE id='loser'`)).toBe(0);
    expect(count(ORPHANS.candidates)).toBe(0);
    expect(count(ORPHANS.pings)).toBe(0);
    expect(count(ORPHANS.coverage)).toBe(0);
  });

  it("a pending candidate is moved only where it would not overwrite the keeper", async () => {
    await merge();
    const rows = raw
      .prepare(
        `SELECT proposed_field f, promoter_id p, decision d, reviewed_by r
         FROM promoter_enrichment_candidates ORDER BY proposed_field`
      )
      .all();
    expect(rows).toEqual([
      { f: "description", p: "keeper", d: "pending", r: null }, // still reviewable
      { f: "hero", p: "keeper", d: "approved", r: null }, // history kept
      { f: "logo", p: "keeper", d: "rejected", r: PROMOTER_MERGE_REVIEWER }, // would overwrite
    ]);
  });

  it("the ping keeps the OLD slug (that URL now 301s) under the keeper's id", async () => {
    await merge();
    expect(raw.prepare(`SELECT entity_id, entity_slug FROM pending_search_pings`).get()).toEqual({
      entity_id: "keeper",
      entity_slug: "loser",
    });
  });

  it("the response and audit row say what was done to the children", async () => {
    const res = await merge();
    expect(res.merged).toBe(true);
    const payload = JSON.parse(
      (
        raw
          .prepare(`SELECT payload_json FROM admin_actions WHERE action='promoter.merge'`)
          .get() as {
          payload_json: string;
        }
      ).payload_json
    );
    expect(payload.children).toEqual({
      candidatesRetargeted: 1,
      candidatesRejected: 1,
      candidatesHistoryRepointed: 1,
      pingsRepointed: 1,
      coverageRowsDeleted: 1,
    });
  });
});
