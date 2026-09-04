/**
 * OPE-769 — `problem_reports` was two queues in one table.
 *
 * Four of its five open `web` rows were claim-verification evidence, written by
 * `/api/claim/evidence` as an operator notification. So "5 unresolved problem
 * reports" read as five open bugs when it was ONE — aéhkō's vendor-profile
 * report of 2026-08-27 — while live claim-funnel work sat in a queue no claim
 * reviewer looks at (Emma Welford's promoter evidence, since 08-17).
 *
 * The evidence was never *misfiled*, it was **double**-filed: the same request
 * writes `entity_claims` first. So the fix is to stop the second write and to
 * make the count mean one thing, not to migrate data somewhere new.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION = readFileSync(
  join(process.cwd(), "drizzle", "0264_ope769_problem_report_kind.sql"),
  "utf8"
);

/** The table as it stood BEFORE this migration — no `kind`. */
const BEFORE_SQL = `
  CREATE TABLE problem_reports (
    id TEXT PRIMARY KEY,
    reporter_email TEXT,
    body TEXT NOT NULL,
    source TEXT NOT NULL,
    path TEXT,
    user_agent TEXT,
    inbound_email_id TEXT,
    severity TEXT NOT NULL DEFAULT 'LOW',
    correlated_error_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER,
    resolved_by_user_id TEXT,
    notes TEXT
  );
`;

let db: InstanceType<typeof Database>;

/** The five open rows as they actually stood on 2026-09-02. */
function seedLiveRows() {
  const rows: Array<[string, string, string | null]> = [
    ["1913c809", "web", "/claim/verify/vendor/ek-resin-creations"],
    ["cb8ffa37", "web", "/claim/verify/vendor/comparion-insurance-agency-2"],
    ["8d5d0bae", "web", "Vendor Profile Not Updating"], // the ONE real defect
    ["104c3d3f", "web", "/claim/verify/promoter/paradise-city-arts-festivals"],
    ["a2c1a082", "web", "/claim/verify/vendor/gooseberry-leather-company"],
  ];
  for (const [id, source, path] of rows) {
    db.prepare(
      `INSERT INTO problem_reports (id, body, source, path, created_at) VALUES (?,?,?,?,0)`
    ).run(id, `body-${id}`, source, path);
  }
}

const openCount = (kind: string) =>
  (
    db
      .prepare(`SELECT count(*) AS n FROM problem_reports WHERE resolved_at IS NULL AND kind = ?`)
      .get(kind) as { n: number }
  ).n;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(BEFORE_SQL);
});

describe("drizzle/0264 — reclassifying the two queues", () => {
  it("turns 5 open 'problem reports' into 1 open defect", () => {
    // The acceptance criterion, exactly as written on the ticket.
    seedLiveRows();
    expect((db.prepare(`SELECT count(*) AS n FROM problem_reports`).get() as { n: number }).n).toBe(
      5
    );

    db.exec(MIGRATION);

    expect(openCount("defect")).toBe(1);
    expect(openCount("claim_evidence")).toBe(4);
  });

  it("leaves the surviving defect intact and identifiable", () => {
    seedLiveRows();
    db.exec(MIGRATION);
    const defect = db
      .prepare(`SELECT id, path FROM problem_reports WHERE kind = 'defect'`)
      .get() as { id: string; path: string };
    expect(defect.id).toBe("8d5d0bae"); // aéhkō
    expect(defect.path).toBe("Vendor Profile Not Updating");
  });

  it("reclassifies by the WRITER's path shape, not a hardcoded id list", () => {
    // An id list would silently do nothing for a row filed between the
    // migration being written and applied — and would still report success.
    // A fifth claim row must be caught too.
    seedLiveRows();
    db.prepare(
      `INSERT INTO problem_reports (id, body, source, path, created_at) VALUES (?,?,?,?,0)`
    ).run("new-one", "filed later", "web", "/claim/verify/vendor/someone-else");

    db.exec(MIGRATION);

    expect(openCount("claim_evidence")).toBe(5);
    expect(openCount("defect")).toBe(1);
  });

  it("defaults to 'defect' — an unclassified row joins the queue somebody drains", () => {
    // The safe direction. Defaulting to a non-drained kind would make a new
    // report disappear, which is strictly worse than one extra row to triage.
    db.exec(MIGRATION);
    db.prepare(
      `INSERT INTO problem_reports (id, body, source, path, created_at) VALUES (?,?,?,?,0)`
    ).run("brand-new", "something is broken", "web", "/events/some-fair");
    expect(openCount("defect")).toBe(1);
  });

  it("is a no-op on an empty database — CI applies it to a fresh D1", () => {
    expect(() => db.exec(MIGRATION)).not.toThrow();
    expect((db.prepare(`SELECT count(*) AS n FROM problem_reports`).get() as { n: number }).n).toBe(
      0
    );
  });
});

describe("OPE-769 — the double-write is gone from the evidence route", () => {
  const route = readFileSync(
    join(process.cwd(), "src", "app", "api", "claim", "evidence", "route.ts"),
    "utf8"
  );

  it("still writes the evidence to entity_claims — that was never the problem", () => {
    // Positive landmark. If this ever stops being true, the assertion below
    // stops meaning "we removed a duplicate" and starts meaning "we deleted the
    // only record of a customer's claim evidence".
    expect(route).toContain("entityClaims");
    expect(route).toMatch(/insert\(entityClaims\)/);
  });

  it("no longer writes a problem_reports row", () => {
    expect(route).not.toMatch(/insert\(problemReports\)/);
  });
});
