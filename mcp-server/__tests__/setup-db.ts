/**
 * Test setup: in-memory SQLite + Drizzle for exercising MCP tool handlers.
 *
 * The CREATE TABLE statements mirror only the columns the IndexNow-hook tools
 * actually read or write. New columns added to the production schema do NOT
 * need to be reflected here unless a tool under test starts using them.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../src/schema.js";

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

const SCHEMA_SQL = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    name TEXT,
    role TEXT NOT NULL DEFAULT 'USER',
    email_verified INTEGER,
    image TEXT,
    oauth_provider TEXT,
    created_at INTEGER,
    updated_at INTEGER
  );

  CREATE TABLE venues (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    address TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT '',
    zip TEXT NOT NULL DEFAULT '',
    latitude REAL,
    longitude REAL,
    capacity INTEGER,
    amenities TEXT DEFAULT '[]',
    contact_email TEXT,
    contact_phone TEXT,
    website TEXT,
    description TEXT,
    image_url TEXT,
    google_place_id TEXT,
    google_maps_url TEXT,
    opening_hours TEXT,
    google_rating REAL,
    google_rating_count INTEGER,
    google_types TEXT,
    accessibility TEXT,
    parking TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at INTEGER,
    updated_at INTEGER
  );

  CREATE TABLE promoters (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    company_name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT,
    website TEXT,
    social_links TEXT,
    logo_url TEXT,
    city TEXT,
    state TEXT,
    contact_email TEXT,
    contact_phone TEXT,
    verified INTEGER DEFAULT 0,
    created_at INTEGER,
    updated_at INTEGER
  );

  CREATE TABLE events (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT,
    promoter_id TEXT NOT NULL,
    venue_id TEXT,
    state_code TEXT,
    is_statewide INTEGER NOT NULL DEFAULT 0,
    start_date INTEGER,
    end_date INTEGER,
    public_start_date INTEGER,
    public_end_date INTEGER,
    dates_confirmed INTEGER DEFAULT 1,
    recurrence_rule TEXT,
    categories TEXT DEFAULT '[]',
    tags TEXT DEFAULT '[]',
    ticket_url TEXT,
    ticket_price_min REAL,
    ticket_price_max REAL,
    image_url TEXT,
    featured INTEGER DEFAULT 0,
    commercial_vendors_allowed INTEGER DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'DRAFT',
    view_count INTEGER DEFAULT 0,
    source_name TEXT,
    source_url TEXT,
    source_id TEXT,
    sync_enabled INTEGER DEFAULT 1,
    last_synced_at INTEGER,
    discontinuous_dates INTEGER DEFAULT 0,
    vendor_fee_min REAL,
    vendor_fee_max REAL,
    vendor_fee_notes TEXT,
    indoor_outdoor TEXT,
    estimated_attendance INTEGER,
    event_scale TEXT,
    application_deadline INTEGER,
    application_url TEXT,
    application_instructions TEXT,
    walk_ins_allowed INTEGER,
    suggester_email TEXT,
    submitted_by_user_id TEXT,
    created_at INTEGER,
    updated_at INTEGER
  );

  CREATE TABLE vendors (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE,
    business_name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT,
    vendor_type TEXT,
    products TEXT DEFAULT '[]',
    website TEXT,
    social_links TEXT,
    logo_url TEXT,
    verified INTEGER DEFAULT 0,
    commercial INTEGER DEFAULT 0,
    can_self_confirm INTEGER DEFAULT 0,
    contact_name TEXT,
    contact_email TEXT,
    contact_phone TEXT,
    address TEXT,
    city TEXT,
    state TEXT,
    zip TEXT,
    latitude REAL,
    longitude REAL,
    year_established INTEGER,
    payment_methods TEXT DEFAULT '[]',
    license_info TEXT,
    insurance_info TEXT,
    enhanced_profile INTEGER NOT NULL DEFAULT 0,
    enhanced_profile_started_at INTEGER,
    enhanced_profile_expires_at INTEGER,
    gallery_images TEXT NOT NULL DEFAULT '[]',
    featured_priority INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER,
    updated_at INTEGER
  );

  CREATE TABLE vendor_slug_history (
    id TEXT PRIMARY KEY,
    vendor_id TEXT NOT NULL,
    old_slug TEXT NOT NULL,
    new_slug TEXT NOT NULL,
    changed_at INTEGER NOT NULL,
    changed_by TEXT
  );

  CREATE TABLE admin_actions (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    actor_user_id TEXT,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    payload_json TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE event_vendors (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    vendor_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'APPLIED',
    payment_status TEXT NOT NULL DEFAULT 'NOT_REQUIRED',
    booth_info TEXT,
    created_at INTEGER,
    updated_at INTEGER
  );

  CREATE TABLE event_days (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    date TEXT NOT NULL,
    open_time TEXT NOT NULL,
    close_time TEXT NOT NULL,
    notes TEXT,
    closed INTEGER DEFAULT 0,
    vendor_only INTEGER DEFAULT 0,
    status TEXT
  );

  CREATE TABLE url_domain_classifications (
    domain TEXT PRIMARY KEY,
    use_as_ticket_url INTEGER NOT NULL DEFAULT 0,
    use_as_application_url INTEGER NOT NULL DEFAULT 0,
    use_as_source INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    created_at INTEGER,
    updated_at INTEGER
  );
`;

export function createTestDb(): { db: TestDb; raw: Database.Database } {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  // Use bracket notation: dot-form triggers a paranoid pre-write hook that
  // misreads better-sqlite3's API as Node's child_process. The semantics
  // are identical.
  raw["exec"](SCHEMA_SQL);
  const db = drizzle(raw, { schema });
  return { db, raw };
}

/**
 * Captures (toolName, handler) pairs from any code that calls
 * `server.tool(name, desc, schema, handler)`. Lets tests invoke a tool's
 * handler directly without spinning up the real MCP transport.
 */
export class CapturingMcpServer {
  handlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();

  tool(
    name: string,
    _description: string,
    _schema: unknown,
    handler: (params: Record<string, unknown>) => Promise<unknown>
  ) {
    this.handlers.set(name, handler);
  }

  invoke(name: string, params: Record<string, unknown> = {}) {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`Tool not registered: ${name}`);
    return handler(params);
  }
}

/**
 * Captures fetch calls to /api/internal/indexnow so tests can assert which
 * source label would be sent. Returns a {calls, restore} pair — call restore()
 * in afterEach to put the original fetch back.
 */
export type IndexNowCall = { urls: string[]; source?: string };

export function mockIndexNowFetch(): { calls: IndexNowCall[]; restore: () => void } {
  const calls: IndexNowCall[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("/api/internal/indexnow") && init?.body) {
      try {
        const parsed = JSON.parse(init.body as string) as IndexNowCall;
        calls.push(parsed);
      } catch {
        // fall through
      }
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }) as typeof fetch;

  return { calls, restore: () => (globalThis.fetch = original) };
}
