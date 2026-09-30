/**
 * OPE-59 — POST /api/claim/evidence: attaches evidence to the user's PENDING
 * claim.
 *
 * OPE-769 — it used to ALSO write a problem_reports row "to surface it to
 * operators". That was a duplicate of the entity_claims write in the same
 * request, and it polluted the defect queue: four of the five open `web` rows
 * were claim evidence, so "5 unresolved problem reports" read as five open bugs
 * when it was one. The row is gone; the evidence is unaffected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/lib/db/schema";

const SCHEMA_SQL = `
  CREATE TABLE vendors (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    business_name TEXT NOT NULL,
    slug TEXT NOT NULL,
    updated_at INTEGER
  );
  CREATE TABLE promoters (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    company_name TEXT NOT NULL,
    slug TEXT NOT NULL,
    updated_at INTEGER
  );
  CREATE TABLE entity_claims (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    method TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    evidence TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER,
    decided_by TEXT
  );
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

let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let mockSession: { user: { id: string; email: string } } | null;

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => mockSession),
}));
vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: vi.fn(() => db),
}));
vi.mock("@/lib/logger", () => ({
  logError: vi.fn(),
}));

import { POST } from "../evidence/route";

function makeRequest(body: unknown) {
  return new NextRequest("http://localhost/api/claim/evidence", {
    method: "POST",
    headers: { "Content-Type": "application/json", "user-agent": "test-agent" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
  mockSession = { user: { id: "user-1", email: "claimant@example.com" } };
  raw
    .prepare(`INSERT INTO vendors (id, user_id, business_name, slug) VALUES (?, ?, ?, ?)`)
    .run("v1", "placeholder", "Acme Foods", "acme-foods");
});
afterEach(() => raw.close());

describe("POST /api/claim/evidence", () => {
  it("401 when not signed in", async () => {
    mockSession = null;
    const res = await POST(
      makeRequest({ entityType: "VENDOR", slug: "acme-foods", evidence: "x" })
    );
    expect(res.status).toBe(401);
  });

  it("400 for missing evidence", async () => {
    const res = await POST(makeRequest({ entityType: "VENDOR", slug: "acme-foods" }));
    expect(res.status).toBe(400);
  });

  it("404 for unknown listing", async () => {
    const res = await POST(
      makeRequest({ entityType: "VENDOR", slug: "nope", evidence: "I own this" })
    );
    expect(res.status).toBe(404);
  });

  it("creates a PENDING claim with the evidence, and NO problem_report (OPE-769)", async () => {
    const res = await POST(
      makeRequest({
        entityType: "VENDOR",
        slug: "acme-foods",
        evidence: "I can reply from our business email.",
      })
    );
    expect(res.status).toBe(200);

    const claims = raw
      .prepare(`SELECT * FROM entity_claims WHERE entity_id = 'v1'`)
      .all() as Array<{
      user_id: string;
      status: string;
      method: string;
      evidence: string;
    }>;
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      user_id: "user-1",
      status: "PENDING",
      method: "EVIDENCE",
      evidence: "I can reply from our business email.",
    });

    // OPE-769 — the defect queue stays a defect queue. The assertion above is
    // the positive landmark for this one: the evidence IS persisted, so an
    // empty problem_reports means "we stopped duplicating", not "we lost it".
    const reports = raw.prepare(`SELECT * FROM problem_reports`).all();
    expect(reports).toHaveLength(0);
  });

  it("reuses the existing PENDING claim (from signup) instead of duplicating", async () => {
    raw
      .prepare(
        `INSERT INTO entity_claims (id, entity_type, entity_id, user_id, method, status, created_at)
         VALUES (?, 'VENDOR', 'v1', 'user-1', 'EVIDENCE', 'PENDING', ?)`
      )
      .run("c-existing", Math.floor(Date.now() / 1000));

    const res = await POST(
      makeRequest({ entityType: "VENDOR", slug: "acme-foods", evidence: "here is my proof" })
    );
    expect(res.status).toBe(200);

    const claims = raw
      .prepare(`SELECT * FROM entity_claims WHERE entity_id = 'v1'`)
      .all() as Array<{
      id: string;
      evidence: string;
    }>;
    expect(claims).toHaveLength(1);
    expect(claims[0].id).toBe("c-existing");
    expect(claims[0].evidence).toBe("here is my proof");
  });
});
