/**
 * OPE-1377 — POST /api/claim/wizard (OPE-64 claim verification ladder).
 *
 * Instant approval (email/domain match) must only happen for a DB-verified
 * email. Negative: no session → 401 and the resolver never runs; an
 * unverified user who sends `emailVerified: true` in the body is still
 * resolved as unverified. Positive: a DB-verified user is resolved as verified
 * and the approved outcome is returned.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { NextRequest } from "next/server";
import * as schema from "@/lib/db/schema";

let db: unknown;
let session: { user: { id: string; roles: string[] } } | null = null;
const resolveClaimInWizard = vi.fn();

vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: () => db,
  getCloudflareEnv: () => ({}),
}));
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => session),
  hasRole: (s: { user?: { roles?: string[] } } | null, role: string) =>
    !!s?.user?.roles?.includes(role),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  rateLimitResponse: vi.fn(),
}));
vi.mock("@/lib/claims/resolve-claim-in-wizard", () => ({
  resolveClaimInWizard: (...a: unknown[]) => resolveClaimInWizard(...a),
}));
vi.mock("@/lib/analytics/claim-funnel", () => ({
  trackClaimVerificationAttemptedServer: vi.fn(async () => undefined),
  trackClaimCompletedServer: vi.fn(async () => undefined),
}));

import { POST } from "../route";

function ddlFor(table: Parameters<typeof getTableConfig>[0]): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const type = c.getSQLType().toUpperCase().includes("INT") ? "INTEGER" : "TEXT";
    return `  ${c.name} ${type}${c.primary ? " PRIMARY KEY" : ""}`;
  });
  return `CREATE TABLE ${cfg.name} (\n${cols.join(",\n")}\n);`;
}

const post = (body: unknown) =>
  POST(
    new NextRequest("https://example.com/api/claim/wizard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) }
  );

beforeEach(() => {
  const raw = new Database(":memory:");
  raw.exec(ddlFor(schema.users));
  raw
    .prepare("INSERT INTO users (id, email, email_verified) VALUES ('nv','nv@acme.com', NULL)")
    .run();
  raw
    .prepare(
      "INSERT INTO users (id, email, email_verified) VALUES ('ok','ok@acme.com', 1780000000)"
    )
    .run();
  db = drizzle(raw, { schema });
  session = null;
  resolveClaimInWizard.mockReset();
});

describe("POST /api/claim/wizard (OPE-1377)", () => {
  it("401 with no session; the resolver never runs", async () => {
    const res = await post({ entityType: "VENDOR", slug: "acme" });
    expect(res.status).toBe(401);
    expect(resolveClaimInWizard).not.toHaveBeenCalled();
  });

  it("an unverified user cannot claim verified status via the request body", async () => {
    session = { user: { id: "nv", roles: ["USER"] } };
    resolveClaimInWizard.mockResolvedValue({
      outcome: "pending_verification",
      method: "EMAIL_MATCH",
      entityType: "VENDOR",
      entitySlug: "acme",
    });
    const res = await post({ entityType: "VENDOR", slug: "acme", emailVerified: true });
    expect(res.status).toBe(200);
    expect(resolveClaimInWizard).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: "nv", userEmail: "nv@acme.com", emailVerified: false })
    );
  });

  it("a DB-verified user is resolved as verified and gets the approved outcome", async () => {
    session = { user: { id: "ok", roles: ["USER"] } };
    resolveClaimInWizard.mockResolvedValue({
      outcome: "approved",
      method: "EMAIL_MATCH",
      entityType: "VENDOR",
      entityName: "Acme",
      entitySlug: "acme",
    });
    const res = await post({ entityType: "VENDOR", slug: "acme" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      outcome: "approved",
      method: "EMAIL_MATCH",
      entityType: "VENDOR",
      entityName: "Acme",
      entitySlug: "acme",
    });
    expect(resolveClaimInWizard).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: "ok", emailVerified: true })
    );
  });

  it("unknown listing → 404", async () => {
    session = { user: { id: "ok", roles: ["USER"] } };
    resolveClaimInWizard.mockResolvedValue({ outcome: "entity_not_found", entityType: "VENDOR" });
    const res = await post({ entityType: "VENDOR", slug: "nope" });
    expect(res.status).toBe(404);
  });
});
