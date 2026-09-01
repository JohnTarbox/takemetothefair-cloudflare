/**
 * OPE-714 — a `type` discarded on a dedup match now leaves a receipt.
 *
 * The acceptance is deliberately hostile to a weak test:
 *
 *   "If the only evidence the fix works is that the call returned `ok`, it has
 *    not been tested; the current behaviour also returns `ok`."
 *
 * So every assertion below reads a DURABLE ROW after the call. The `Cutco` case
 * is the ticket's own walkthrough: stored as "RV Accessories", relinked from a
 * source that says "Cutlery".
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@takemetothefair/db-schema";
import { createOrLinkVendor } from "@takemetothefair/vendor-linking";

const SCHEMA_SQL = `
  CREATE TABLE events (
    id TEXT PRIMARY KEY, slug TEXT, name TEXT, source_url TEXT
  );
  CREATE TABLE vendors (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE,
    business_name TEXT NOT NULL,
    -- EH2.1 (drizzle/0121, 2026-06-09) — optional brand display override.
    display_name TEXT,
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
    claimed INTEGER NOT NULL DEFAULT 0,
    claimed_at INTEGER,
    claimed_by TEXT,
    view_count INTEGER NOT NULL DEFAULT 0,
    verified_pro INTEGER NOT NULL DEFAULT 0,
    verified_pro_at INTEGER,
    verified_pro_by TEXT,
    deleted_at INTEGER,
    redirect_to_vendor_id TEXT,
    enrichment_source TEXT,
    enrichment_attempted_at INTEGER,
    domain_hijacked INTEGER NOT NULL DEFAULT 0,
    completeness_score INTEGER NOT NULL DEFAULT 0,
    -- EH1 Phase 1 (drizzle/0106 + 0107, 2026-06-05) — vendor hierarchy +
    -- relationship model. Mirror the columns on the real vendors table
    -- so tests using the Drizzle schema can INSERT without "no such
    -- column" errors. Whenever a column is renamed or added to the
    -- vendors table this block MUST be updated in lockstep — vitest
    -- silently fails the affected test with "no such column" otherwise.
    role TEXT NOT NULL DEFAULT 'INDEPENDENT',
    brand_parent_vendor_id TEXT,
    operator_parent_vendor_id TEXT,
    alias_of_vendor_id TEXT,
    relationship_type TEXT NOT NULL DEFAULT 'independent',
    default_child_display TEXT,
    display_override_permitted INTEGER NOT NULL DEFAULT 0,
    display_mode TEXT,
    created_at INTEGER,
    updated_at INTEGER,
    image_focal_x REAL NOT NULL DEFAULT 0.5,
    image_focal_y REAL NOT NULL DEFAULT 0.5
  );
  CREATE TABLE event_vendors (
    id TEXT PRIMARY KEY, event_id TEXT, vendor_id TEXT, status TEXT,
    booth_info TEXT, payment_status TEXT, participation_type TEXT,
    public_visible INTEGER, event_day_id TEXT, created_at INTEGER, updated_at INTEGER
  );
  CREATE TABLE event_days (id TEXT PRIMARY KEY, event_id TEXT, date TEXT);
  -- users/vendors DDL lifted verbatim from mcp-server/__tests__/setup-db.ts
  -- rather than hand-rolled: the CREATE path mints an ingestion placeholder
  -- OWNER row (OPE-292) and guessing its columns is how this test spent three
  -- runs chasing "no such column" errors.
  CREATE TABLE users (
    -- OPE-292 — mirrors the users.origin column; NOT NULL with a default.
    origin TEXT NOT NULL DEFAULT 'registration',
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
  CREATE TABLE admin_actions (
    id TEXT PRIMARY KEY, action TEXT, actor_user_id TEXT, target_type TEXT,
    target_id TEXT, payload_json TEXT, created_at INTEGER
  );
  CREATE TABLE vendor_enrichment_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id TEXT NOT NULL, job_run_id TEXT NOT NULL,
    proposed_field TEXT NOT NULL, current_value TEXT,
    proposed_value TEXT NOT NULL, source_url TEXT NOT NULL,
    extraction_method TEXT NOT NULL, fetch_method TEXT,
    confidence REAL NOT NULL DEFAULT 0, flags TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL, reviewed_at INTEGER, reviewed_by TEXT,
    decision TEXT NOT NULL DEFAULT 'pending'
  );
  CREATE UNIQUE INDEX idx_vec_pending_field
    ON vendor_enrichment_candidates(vendor_id, proposed_field)
    WHERE decision = 'pending';
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;

const deps = {
  actorUserId: null,
  recomputeVendorCompleteness: async () => undefined,
  logEnrichment: async () => undefined,
};

function seedEvent(id: string, sourceUrl: string | null = null) {
  raw
    .prepare(`INSERT INTO events (id, slug, name, source_url) VALUES (?,?,?,?)`)
    .run(id, id, id, sourceUrl);
}
function seedVendor(id: string, name: string, type: string | null) {
  // vendors.user_id is NOT NULL — every vendor has an owner row, which for an
  // ingested vendor is the `pending+` placeholder (OPE-292).
  raw
    .prepare(`INSERT INTO users (id, email, origin) VALUES (?,?,?)`)
    .run(`u-${id}`, `pending+${id}@meetmeatthefair.com`, "ingestion");
  raw
    .prepare(
      `INSERT INTO vendors (id, user_id, business_name, slug, vendor_type) VALUES (?,?,?,?,?)`
    )
    .run(id, `u-${id}`, name, id, type);
}
const candidates = () =>
  raw.prepare(`SELECT * FROM vendor_enrichment_candidates`).all() as Array<Record<string, unknown>>;

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

describe("the Cutco walkthrough", () => {
  it("records the disagreement as a recoverable pending row", async () => {
    seedEvent("marshfield", "https://marshfieldfair.org/vendors");
    seedVendor("cutco", "Cutco", "RV Accessories");

    const res = await createOrLinkVendor(
      db,
      { eventId: "marshfield", businessName: "Cutco", type: "Cutlery" },
      deps
    );
    expect(res.ok).toBe(true);

    // The acceptance: recoverable AFTER the call, from a durable row.
    const [c] = candidates();
    expect(c.vendor_id).toBe("cutco");
    expect(c.proposed_field).toBe("vendor_type");
    expect(c.current_value).toBe("RV Accessories");
    expect(c.proposed_value).toBe("Cutlery");
    expect(c.decision).toBe("pending");
    expect(c.source_url).toBe("https://marshfieldfair.org/vendors");
    expect(JSON.parse(c.flags as string)).toContain("type_disagreement");
  });

  it("does NOT overwrite the stored type", async () => {
    // The safe default the ticket insisted on keeping: a link call must not
    // clobber a curated field just by mentioning a vendor.
    seedEvent("marshfield");
    seedVendor("cutco", "Cutco", "RV Accessories");
    await createOrLinkVendor(
      db,
      { eventId: "marshfield", businessName: "Cutco", type: "Cutlery" },
      deps
    );
    const v = raw.prepare(`SELECT vendor_type FROM vendors WHERE id='cutco'`).get() as {
      vendor_type: string;
    };
    expect(v.vendor_type).toBe("RV Accessories");
  });

  it("falls back to our own event URL when the event has no source_url", async () => {
    // source_url is NOT NULL. It must never be fabricated — it is how a reviewer
    // retraces the claim — so the fallback is a real, resolvable URL.
    seedEvent("marshfield", null);
    seedVendor("cutco", "Cutco", "RV Accessories");
    await createOrLinkVendor(
      db,
      { eventId: "marshfield", businessName: "Cutco", type: "Cutlery" },
      deps
    );
    expect(candidates()[0].source_url).toBe("https://meetmeatthefair.com/events/marshfield");
  });
});

describe("it stays quiet when there is nothing to say", () => {
  it("no receipt when the types agree", async () => {
    seedEvent("e1");
    seedVendor("v1", "Acme", "Jewelry");
    await createOrLinkVendor(db, { eventId: "e1", businessName: "Acme", type: "Jewelry" }, deps);
    expect(candidates()).toHaveLength(0);
  });

  it("no receipt when the caller supplied no type", async () => {
    seedEvent("e1");
    seedVendor("v1", "Acme", "Jewelry");
    await createOrLinkVendor(db, { eventId: "e1", businessName: "Acme" }, deps);
    expect(candidates()).toHaveLength(0);
  });

  it("no receipt on CREATE — the type is applied, not discarded", async () => {
    // Nothing was dropped, so there is nothing to record. A receipt here would
    // be noise on every new vendor.
    seedEvent("e1");
    await createOrLinkVendor(db, { eventId: "e1", businessName: "Brand New", type: "Fiber" }, deps);
    expect(candidates()).toHaveLength(0);
    const v = raw
      .prepare(`SELECT vendor_type FROM vendors WHERE business_name='Brand New'`)
      .get() as { vendor_type: string };
    expect(v.vendor_type).toBe("Fiber");
  });

  it("records the DCF case — stored type is NULL", async () => {
    // The row the ticket says fill-if-null would have closed. It is captured
    // here too, as a proposal rather than a write.
    seedEvent("nauset");
    seedVendor("dcf", "Dept. of Children and Families Foster Care", null);
    await createOrLinkVendor(
      db,
      {
        eventId: "nauset",
        businessName: "Dept. of Children and Families Foster Care",
        type: "Government / Nonprofit",
      },
      deps
    );
    const [c] = candidates();
    expect(c.current_value).toBeNull();
    expect(c.proposed_value).toBe("Government / Nonprofit");
  });
});

describe("a re-drain does not pile up rows", () => {
  it("the fiftieth pass to meet Cutco does not create a fiftieth proposal", async () => {
    // Without the partial unique + onConflictDoNothing this grows unboundedly,
    // because "every future drain re-observes and re-discards" is the ticket's
    // own description of the status quo.
    seedEvent("e1");
    seedVendor("cutco", "Cutco", "RV Accessories");
    for (let i = 0; i < 3; i++) {
      const r = await createOrLinkVendor(
        db,
        { eventId: "e1", businessName: "Cutco", type: "Cutlery" },
        deps
      );
      expect(r.ok).toBe(true); // the link still succeeds every time
    }
    expect(candidates()).toHaveLength(1);
  });
});
