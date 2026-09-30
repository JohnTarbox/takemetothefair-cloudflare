/**
 * OPE-237, 2026-09-14 — the corroboration pass as the nightly cron runs it.
 *
 * Real SQLite, real route, mocked network. Pins the three things the cron adds
 * that a classifier unit test cannot see:
 *   - an attempt that ENDS in UNAVAILABLE (a bot wall) is not re-fetched on the
 *     next run, or the cron becomes a crawler;
 *   - every sweep run writes its `claim.corroborate.sweep` liveness row, even a
 *     run that found nothing;
 *   - a single-vendor re-check does not refresh that liveness.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";

let sqlite: Database.Database;
const fetchMock = vi.fn();

vi.mock("@/lib/api-auth", () => ({ isAuthorized: async () => true }));
vi.mock("@/lib/logger", () => ({ logError: async () => undefined }));
vi.mock("@/lib/cloudflare", () => ({ getCloudflareDb: () => drizzle(sqlite, { schema }) }));
vi.mock("@takemetothefair/site-fetch", () => ({
  fetchHtmlWithSsrfGuard: (url: string) => fetchMock(url),
}));

const { POST } = await import("@/app/api/admin/claims/corroborate/route");

const SCHEMA_SQL = `
  CREATE TABLE vendor_claim_evidence (
    id TEXT PRIMARY KEY, vendor_id TEXT NOT NULL UNIQUE, user_id TEXT,
    claimant_name TEXT, claimant_email TEXT, business_name TEXT NOT NULL,
    declared_website TEXT, signals TEXT NOT NULL DEFAULT '{}',
    corroboration TEXT NOT NULL DEFAULT 'UNAVAILABLE', corroboration_detail TEXT,
    score INTEGER NOT NULL DEFAULT 0, band TEXT NOT NULL DEFAULT 'NEEDS_REVIEW',
    reasons TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL,
    assessed_at INTEGER, reviewed_at INTEGER, reviewed_by TEXT
  );
  CREATE TABLE admin_actions (
    id TEXT PRIMARY KEY, action TEXT NOT NULL, actor_user_id TEXT,
    target_type TEXT NOT NULL, target_id TEXT NOT NULL, payload_json TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, email_verified INTEGER);
`;

function seed(vendorId: string, website: string | null, business = "Hive to Heart") {
  sqlite
    .prepare(
      `INSERT INTO vendor_claim_evidence (id, vendor_id, claimant_name, claimant_email,
         business_name, declared_website, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(`e-${vendorId}`, vendorId, "Pat Maker", `${vendorId}@example.com`, business, website, 1);
}

function run(body: Record<string, unknown> = {}) {
  return POST(
    new Request("http://localhost/api/admin/claims/corroborate", {
      method: "POST",
      body: JSON.stringify(body),
    })
  ).then((r) => r.json() as Promise<{ eligible: number; results: { corroboration: string }[] }>);
}

const row = (vendorId: string) =>
  sqlite
    .prepare(
      "SELECT corroboration, corroboration_detail FROM vendor_claim_evidence WHERE vendor_id = ?"
    )
    .get(vendorId) as { corroboration: string; corroboration_detail: string | null };

const sweepStamps = () =>
  (
    sqlite
      .prepare("SELECT COUNT(*) AS n FROM admin_actions WHERE action = 'claim.corroborate.sweep'")
      .get() as { n: number }
  ).n;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(SCHEMA_SQL);
  fetchMock.mockReset();
});

describe("OPE-237 corroboration pass — cron shape", () => {
  it("a walled platform ends UNAVAILABLE with a detail, unfetched, and is NOT re-attempted next run", async () => {
    seed("v-ig", "https://www.instagram.com/blendofelements");

    const first = await run();
    expect(first.eligible).toBe(1);
    expect(row("v-ig").corroboration).toBe("UNAVAILABLE");
    expect(row("v-ig").corroboration_detail).toContain("Instagram");
    expect(fetchMock).not.toHaveBeenCalled();

    const second = await run();
    expect(second.eligible).toBe(0);
  });

  it("a 429 from an ordinary site is UNAVAILABLE and also not re-fetched nightly", async () => {
    seed("v-429", "https://busy.example");
    fetchMock.mockResolvedValue({ ok: false, error: "http_429" });

    await run();
    expect(row("v-429").corroboration).toBe("UNAVAILABLE");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await run();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a 404 is still the WEAK caution case", async () => {
    seed("v-404", "https://gone.example");
    fetchMock.mockResolvedValue({ ok: false, error: "http_404" });

    await run();
    expect(row("v-404").corroboration).toBe("WEAK");
  });

  it("a live site naming the business is STRONG", async () => {
    seed("v-ok", "https://hive2heart.example");
    fetchMock.mockResolvedValue({ ok: true, html: "<h1>Hive to Heart</h1>" });

    await run();
    expect(row("v-ok").corroboration).toBe("STRONG");
  });

  it("every sweep run stamps liveness, including a run with nothing eligible", async () => {
    await run();
    await run();
    expect(sweepStamps()).toBe(2);
  });

  it("a single-vendor re-check does not refresh the cron's liveness", async () => {
    seed("v-ig", "https://www.instagram.com/blendofelements");
    await run({ vendor_id: "v-ig" });
    expect(row("v-ig").corroboration).toBe("UNAVAILABLE");
    expect(sweepStamps()).toBe(0);
  });
});

describe("OPE-237 — the probe watches the string the pass actually writes", () => {
  it("heartbeat.ts filters on the action the route inserts, under the seeded probe name", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = join(__dirname, "../../../..");
    const route = readFileSync(join(root, "src/app/api/admin/claims/corroborate/route.ts"), "utf8");
    const heartbeat = readFileSync(join(root, "src/lib/heartbeat.ts"), "utf8");
    const migration = readFileSync(
      join(root, "drizzle/0289_ope237_claim_corroboration_probe.sql"),
      "utf8"
    );
    // Anchored on field syntax, not the bare string: docblocks name it too.
    expect(route).toContain(`action: "claim.corroborate.sweep"`);
    expect(heartbeat).toContain(`eq(adminActions.action, "claim.corroborate.sweep")`);
    expect(heartbeat).toContain(`name: "claim-corroboration-sweep"`);
    expect(migration).toContain(`'claim-corroboration-sweep'`);
  });
});
