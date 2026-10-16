/**
 * OPE-1362 — /api/vendors/export must not hand contact data to anyone with an
 * account. Registration is open and the button sits on the public /vendors
 * page, so USER and VENDOR sessions are effectively the public.
 *
 * Runs the real route against a real SQLite so the deleted_at filter is pinned
 * by SQL semantics, not by a mock's idea of what the WHERE clause means.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/lib/db/schema";

let db: ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let role: string | undefined;

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true }),
  rateLimitResponse: () => null,
}));
vi.mock("@/lib/auth", () => ({
  auth: async () => (role ? { user: { id: "u1", role } } : null),
}));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));
vi.mock("@/lib/cloudflare", () => ({ getCloudflareDb: () => db }));

const { GET } = await import("../route");

const SCHEMA_SQL = `
  CREATE TABLE vendors (
    id TEXT PRIMARY KEY, business_name TEXT NOT NULL, vendor_type TEXT,
    description TEXT, products TEXT DEFAULT '[]', website TEXT,
    contact_name TEXT, contact_email TEXT, contact_phone TEXT,
    address TEXT, city TEXT, state TEXT, zip TEXT, year_established INTEGER,
    payment_methods TEXT DEFAULT '[]', license_info TEXT, insurance_info TEXT,
    verified INTEGER DEFAULT 0, commercial INTEGER DEFAULT 0, deleted_at INTEGER
  );
  CREATE TABLE events (
    id TEXT PRIMARY KEY, status TEXT, lifecycle_status TEXT,
    start_date INTEGER, end_date INTEGER
  );
  CREATE TABLE event_vendors (
    id TEXT PRIMARY KEY, event_id TEXT, vendor_id TEXT, status TEXT,
    public_visible INTEGER NOT NULL DEFAULT 1
  );
`;

const CONTACT_HEADERS = [
  "Contact Name",
  "Contact Email",
  "Contact Phone",
  "License Info",
  "Insurance Info",
];

function seedVendor(id: string, name: string, deletedAt: number | null = null) {
  sqlite
    .prepare(
      `INSERT INTO vendors (id, business_name, contact_name, contact_email, contact_phone,
         license_info, insurance_info, city, state, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Fryeburg', 'ME', ?)`
    )
    .run(
      id,
      name,
      `${id} Person`,
      `${id}@private.test`,
      `207-555-${id.padStart(4, "0").slice(-4)}`,
      `LIC-${id}`,
      `INS-${id}`,
      deletedAt
    );
}

async function exportCsv() {
  const res = await GET(new Request("https://meetmeatthefair.com/api/vendors/export"));
  expect(res.status).toBe(200);
  const text = await res.text();
  const [header, ...rows] = text.split("\n");
  return { text, headers: header.split(","), rows };
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(SCHEMA_SQL);
  db = drizzle(sqlite, { schema });
  seedVendor("1", "Alpha Kettle Corn");
  seedVendor("2", "Bravo Woodworks");
  seedVendor("3", "Gone Vendor", Math.floor(Date.now() / 1000) - 86400);
  // One upcoming public event for Alpha, and one hidden (public_visible=0) link
  // for Bravo — the hidden link is recorded but must not count publicly.
  const future = Math.floor(Date.now() / 1000) + 30 * 86400;
  sqlite
    .prepare(
      `INSERT INTO events (id, status, lifecycle_status, start_date, end_date)
       VALUES ('e1', 'APPROVED', 'SCHEDULED', ?, ?)`
    )
    .run(future, future);
  sqlite.exec(`
    INSERT INTO event_vendors (id, event_id, vendor_id, status, public_visible)
      VALUES ('ev1', 'e1', '1', 'APPROVED', 1), ('ev2', 'e1', '2', 'APPROVED', 0);
  `);
});

describe("GET /api/vendors/export (OPE-1362)", () => {
  it("401s without a session", async () => {
    role = undefined;
    const res = await GET(new Request("https://meetmeatthefair.com/api/vendors/export"));
    expect(res.status).toBe(401);
  });

  for (const r of ["USER", "VENDOR", "PROMOTER"]) {
    it(`${r} session: no contact columns, no contact values, no deleted vendors`, async () => {
      role = r;
      const { text, headers, rows } = await exportCsv();
      for (const h of CONTACT_HEADERS) expect(headers).not.toContain(h);
      expect(text).not.toContain("@private.test");
      expect(text).not.toContain("207-555-");
      expect(text).not.toContain("Person");
      expect(text).not.toContain("LIC-");
      expect(text).not.toContain("INS-");
      expect(text).not.toContain("Gone Vendor");
      expect(rows).toHaveLength(2);
      // Every row has exactly as many cells as the header — the columns were
      // removed, not blanked or misaligned.
      for (const row of rows) expect(row.split(",")).toHaveLength(headers.length);
      // Upcoming count honours the public_visible opt-out for non-admins.
      const countIdx = headers.indexOf("Upcoming Events");
      expect(rows[0].split(",")[countIdx]).toBe("1");
      expect(rows[1].split(",")[countIdx]).toBe("0");
    });
  }

  it("upcoming count uses upcomingEndPredicate (OPE-1375: 24h end grace)", async () => {
    role = "USER";
    // Ended 12h ago: inside the shared 24h grace, so it is still "upcoming" on
    // /vendors. The old inline `end_date >= now` dropped it.
    const endedRecently = Math.floor(Date.now() / 1000) - 12 * 3600;
    sqlite
      .prepare(
        `INSERT INTO events (id, status, lifecycle_status, start_date, end_date)
         VALUES ('e2', 'APPROVED', 'SCHEDULED', ?, ?)`
      )
      .run(endedRecently - 3600, endedRecently);
    sqlite.exec(
      `INSERT INTO event_vendors (id, event_id, vendor_id, status, public_visible)
       VALUES ('ev3', 'e2', '1', 'APPROVED', 1)`
    );
    const { headers, rows } = await exportCsv();
    const countIdx = headers.indexOf("Upcoming Events");
    expect(rows[0].split(",")[countIdx]).toBe("2");
  });

  it("ADMIN session: keeps contact columns and values, still no deleted vendors", async () => {
    role = "ADMIN";
    const { text, headers, rows } = await exportCsv();
    for (const h of CONTACT_HEADERS) expect(headers).toContain(h);
    expect(text).toContain("1@private.test");
    expect(text).toContain("LIC-1");
    expect(text).not.toContain("Gone Vendor");
    expect(rows).toHaveLength(2);
    // Admin keeps the operator view: the hidden link still counts.
    const countIdx = headers.indexOf("Upcoming Events");
    expect(rows[1].split(",")[countIdx]).toBe("1");
  });
});
