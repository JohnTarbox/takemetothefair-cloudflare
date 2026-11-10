/**
 * OPE-1606 — commercial_vendors_allowed: NULL means unknown, never "no".
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { events } from "@/lib/db/schema";
import { checkEventAcceptsVendor } from "@takemetothefair/utils";
import { evaluateOutreachReasons } from "@takemetothefair/db-schema";
import { fitLine, type VendorDigestEvent } from "@/lib/email/vendor-digest";
import { eventCreateSchema } from "@takemetothefair/validation";

const MIGRATION = readFileSync(
  join(process.cwd(), "drizzle/0402_ope1606_commercial_vendors_unknown.sql"),
  "utf8"
);

function migrated() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      commercial_vendors_allowed INTEGER DEFAULT true,
      application_url TEXT,
      vendor_fee_min_cents INTEGER,
      vendor_fee_max_cents INTEGER,
      application_deadline INTEGER,
      source_domain TEXT,
      ingestion_method TEXT
    );
    CREATE TABLE event_days (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE
    );
  `);
  const add = db.prepare(
    `INSERT INTO events (id, commercial_vendors_allowed, application_url, vendor_fee_min_cents,
       vendor_fee_max_cents, application_deadline, source_domain, ingestion_method)
     VALUES (@id, @v, @url, @min, @max, @deadline, @domain, @method)`
  );
  const row = (id: string, v: number | null, over: Record<string, unknown> = {}) =>
    add.run({
      id,
      v,
      url: null,
      min: null,
      max: null,
      deadline: null,
      domain: null,
      method: null,
      ...over,
    });
  row("default-1-null-domain", 1);
  row("default-1-other-domain", 1, { domain: "example.org", method: "web_research" });
  row("blank-url", 1, { url: "   " });
  row("explicit-0", 0);
  row("already-null", null);
  row("has-url", 1, { url: "https://a.example/apply" });
  row("has-fee-min", 1, { min: 7500 });
  row("has-fee-max", 1, { max: 12000 });
  row("has-deadline", 1, { deadline: 1790000000 });
  row("scraper", 1, { domain: "www.fairsandfestivals.net" });
  row("admin-form", 1, { method: "admin_manual" });
  db.exec(`INSERT INTO event_days (id, event_id) VALUES ('d1', 'has-url')`);
  db.exec(MIGRATION);
  return db;
}

const value = (db: Database.Database, id: string) =>
  (
    db.prepare(`SELECT commercial_vendors_allowed v FROM events WHERE id = ?`).get(id) as {
      v: number | null;
    }
  ).v;

describe("the backfill", () => {
  it.each(["default-1-null-domain", "default-1-other-domain", "blank-url", "already-null"])(
    "%s becomes unknown",
    (id) => {
      expect(value(migrated(), id)).toBeNull();
    }
  );

  it.each(["has-url", "has-fee-min", "has-fee-max", "has-deadline", "scraper", "admin-form"])(
    "%s keeps its 1",
    (id) => {
      expect(value(migrated(), id)).toBe(1);
    }
  );

  it("keeps an explicit 0", () => {
    expect(value(migrated(), "explicit-0")).toBe(0);
  });

  it("leaves the column with no default, under its original name", () => {
    const cols = migrated().pragma("table_info(events)") as {
      name: string;
      dflt_value: unknown;
    }[];
    const col = cols.find((c) => c.name === "commercial_vendors_allowed");
    expect(col).toBeDefined();
    expect(col?.dflt_value).toBeNull();
    expect(cols.some((c) => c.name.endsWith("_new"))).toBe(false);
  });

  it("does not disturb a foreign-key child", () => {
    const n = migrated().prepare(`SELECT count(*) n FROM event_days`).get() as { n: number };
    expect(n.n).toBe(1);
  });

  it("is safe on an empty table", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE events (
      id TEXT PRIMARY KEY, commercial_vendors_allowed INTEGER DEFAULT true, application_url TEXT,
      vendor_fee_min_cents INTEGER, vendor_fee_max_cents INTEGER, application_deadline INTEGER,
      source_domain TEXT, ingestion_method TEXT)`);
    expect(() => db.exec(MIGRATION)).not.toThrow();
  });
});

describe("the schema", () => {
  it("has no default, so an insert that omits it stores NULL", () => {
    const col = getTableConfig(events).columns.find((c) => c.name === "commercial_vendors_allowed");
    expect(col?.hasDefault).toBe(false);
    expect(col?.notNull).toBe(false);
  });

  it("the shared create schema no longer invents a yes", () => {
    const shape = eventCreateSchema.safeParse({});
    const field = shape.success
      ? (shape.data as { commercialVendorsAllowed?: unknown }).commercialVendorsAllowed
      : undefined;
    expect(field).toBeUndefined();
  });
});

describe("readers treat NULL as unknown, not no", () => {
  const event = (v: boolean | null) => ({ status: "APPROVED", commercialVendorsAllowed: v });

  it("a commercial vendor is refused only on an explicit no", () => {
    expect(checkEventAcceptsVendor({ commercial: true }, event(null)).ok).toBe(true);
    expect(checkEventAcceptsVendor({ commercial: true }, event(true)).ok).toBe(true);
    expect(checkEventAcceptsVendor({ commercial: true }, event(false)).ok).toBe(false);
  });

  it("the public filter keeps unknown and drops only an explicit no", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE e (id TEXT, v INTEGER);
      INSERT INTO e VALUES ('yes', 1), ('no', 0), ('unknown', NULL);`);
    const ids = (db.prepare(`SELECT id FROM e WHERE v IS NOT 0`).all() as { id: string }[]).map(
      (r) => r.id
    );
    expect(ids.sort()).toEqual(["unknown", "yes"]);
  });

  it("the three filter sites all use that predicate", () => {
    for (const f of [
      "src/lib/events-filter-count.ts",
      "src/app/events/(listing)/page.tsx",
      "src/app/api/events/export/route.ts",
    ]) {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      expect(src, f).toContain("${events.commercialVendorsAllowed} IS NOT 0");
      expect(src, f).not.toContain("eq(events.commercialVendorsAllowed, true)");
    }
  });

  it("the event page refuses a commercial vendor only on an explicit no", () => {
    const src = readFileSync(join(process.cwd(), "src/app/events/[slug]/page.tsx"), "utf8");
    expect(src).toContain(
      "vendorInfo.vendor.commercial && event.commercialVendorsAllowed === false ?"
    );
  });

  it("outreach still asks an organizer whose answer is unknown", () => {
    const base = {
      startDate: new Date("2027-06-01"),
      datesConfirmed: true,
      dateCitationCount: 1,
      tags: [],
      lifecycleStatus: null,
      eventDayCount: 1,
      vendorApplicationUrl: null,
      promoterName: "A",
      promoterContactEmail: "a@b.example",
    };
    const now = new Date("2026-11-10T00:00:00Z");
    const asks = (v: boolean | null) =>
      evaluateOutreachReasons({ ...base, commercialVendorsAllowed: v } as never, now).includes(
        "missing_vendor_application"
      );
    expect(asks(null)).toBe(true);
    expect(asks(true)).toBe(true);
    expect(asks(false)).toBe(false);
  });
});

describe("the vendor digest", () => {
  const e = (v: boolean | null) =>
    ({ categories: [], commercialVendorsAllowed: v }) as unknown as VendorDigestEvent;

  it("prints the line only for an explicit yes", () => {
    expect(fitLine(e(true))).toContain("commercial vendors welcome");
    expect(fitLine(e(null)) ?? "").not.toContain("commercial vendors welcome");
    expect(fitLine(e(false)) ?? "").not.toContain("commercial vendors welcome");
  });
});
