/**
 * OPE-1361 — the token route (`PATCH /api/vendors/[slug]/applications`) applies
 * the session route's rules. Before this, it defaulted a new row to CONFIRMED
 * for any eventId, so any self-registered vendor could publish itself as a
 * confirmed vendor of any event.
 *
 * Real SQLite (better-sqlite3) so the inserts/updates are asserted by reading
 * the row back, not by inspecting mock calls.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import * as schema from "../db/schema";
import type { Database as AppDb } from "../db";
import {
  applyVendorTokenPatch,
  checkEventAcceptsVendor,
  defaultApplicationStatus,
} from "../vendor-applications";

function ddlFor(table: Parameters<typeof getTableConfig>[0]): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const type = c.getSQLType().toUpperCase().includes("INT") ? "INTEGER" : "TEXT";
    return `  ${c.name} ${type}${c.primary ? " PRIMARY KEY" : ""}`;
  });
  return `CREATE TABLE ${cfg.name} (\n${cols.join(",\n")}\n);`;
}

let raw: InstanceType<typeof Database>;
let db: AppDb;

const VERIFIED = 1_780_000_000;

function addVendor(
  id: string,
  opts: { canSelfConfirm?: boolean; commercial?: boolean; verified?: boolean } = {}
) {
  raw
    .prepare("INSERT INTO users (id, email, email_verified) VALUES (?, ?, ?)")
    .run(`u-${id}`, `${id}@example.com`, opts.verified === false ? null : VERIFIED);
  raw
    .prepare(
      "INSERT INTO vendors (id, user_id, business_name, slug, can_self_confirm, commercial) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(id, `u-${id}`, id, id, opts.canSelfConfirm ? 1 : 0, opts.commercial ? 1 : 0);
}

function addEvent(id: string, status: string, commercialVendorsAllowed = true) {
  raw
    .prepare(
      "INSERT INTO events (id, name, slug, status, commercial_vendors_allowed) VALUES (?, ?, ?, ?, ?)"
    )
    .run(id, id, id, status, commercialVendorsAllowed ? 1 : 0);
}

function addLink(vendorId: string, eventId: string, status: string) {
  raw
    .prepare(
      "INSERT INTO event_vendors (id, event_id, vendor_id, status, payment_status) VALUES (?, ?, ?, ?, 'NOT_REQUIRED')"
    )
    .run(`ev-${vendorId}-${eventId}`, eventId, vendorId, status);
}

function linkRow(vendorId: string, eventId: string) {
  return raw
    .prepare(
      "SELECT status, payment_status AS paymentStatus FROM event_vendors WHERE vendor_id = ? AND event_id = ?"
    )
    .get(vendorId, eventId) as { status: string; paymentStatus: string } | undefined;
}

beforeEach(() => {
  raw = new Database(":memory:");
  for (const t of [schema.users, schema.vendors, schema.events, schema.eventVendors]) {
    raw.exec(ddlFor(t));
  }
  db = drizzle(raw, { schema }) as unknown as AppDb;

  addVendor("plain"); // canSelfConfirm = false
  addVendor("trusted", { canSelfConfirm: true });
  addVendor("unverified", { verified: false });
  addVendor("corp", { commercial: true });
  addEvent("open", "APPROVED");
  addEvent("pending", "PENDING");
  addEvent("tentative", "TENTATIVE");
  addEvent("nocorp", "APPROVED", false);
});

describe("applyVendorTokenPatch — new application (OPE-1361)", () => {
  it("a non-canSelfConfirm vendor with no status gets APPLIED, not CONFIRMED", async () => {
    const r = await applyVendorTokenPatch(db, "plain", { eventId: "open" });
    expect(r).toMatchObject({ ok: true, httpStatus: 201, body: { status: "APPLIED" } });
    expect(linkRow("plain", "open")?.status).toBe("APPLIED");
  });

  it("a non-canSelfConfirm vendor asking for CONFIRMED is refused and nothing is written", async () => {
    const r = await applyVendorTokenPatch(db, "plain", { eventId: "open", status: "CONFIRMED" });
    expect(r).toMatchObject({ ok: false, httpStatus: 403 });
    expect(linkRow("plain", "open")).toBeUndefined();
  });

  it("a non-canSelfConfirm vendor asking for APPROVED is refused", async () => {
    const r = await applyVendorTokenPatch(db, "plain", { eventId: "open", status: "APPROVED" });
    expect(r).toMatchObject({ ok: false, httpStatus: 403 });
    expect(linkRow("plain", "open")).toBeUndefined();
  });

  it("a canSelfConfirm vendor is CONFIRMED by default", async () => {
    const r = await applyVendorTokenPatch(db, "trusted", { eventId: "open" });
    expect(r).toMatchObject({ ok: true, body: { status: "CONFIRMED" } });
    expect(linkRow("trusted", "open")?.status).toBe("CONFIRMED");
  });

  it.each(["pending", "tentative"])("refuses a %s (non-APPROVED) event", async (eventId) => {
    const r = await applyVendorTokenPatch(db, "plain", { eventId });
    expect(r).toMatchObject({ ok: false, httpStatus: 400 });
    expect(linkRow("plain", eventId)).toBeUndefined();
  });

  it("refuses a non-existent event", async () => {
    const r = await applyVendorTokenPatch(db, "plain", { eventId: "nope" });
    expect(r).toMatchObject({ ok: false, httpStatus: 404, error: "Event not found" });
  });

  it("refuses a commercial vendor on an event that disallows them", async () => {
    const r = await applyVendorTokenPatch(db, "corp", { eventId: "nocorp" });
    expect(r).toMatchObject({ ok: false, httpStatus: 403 });
    expect(linkRow("corp", "nocorp")).toBeUndefined();
  });

  it("refuses a vendor whose account email is unverified", async () => {
    const r = await applyVendorTokenPatch(db, "unverified", { eventId: "open" });
    expect(r).toMatchObject({ ok: false, httpStatus: 403, error: "email_unverified" });
    expect(linkRow("unverified", "open")).toBeUndefined();
  });

  it("refuses a paymentStatus outside the enum", async () => {
    const r = await applyVendorTokenPatch(db, "plain", { eventId: "open", paymentStatus: "FREE" });
    expect(r).toMatchObject({ ok: false, httpStatus: 400 });
    expect(linkRow("plain", "open")).toBeUndefined();
  });

  it("refuses a status outside the enum", async () => {
    const r = await applyVendorTokenPatch(db, "plain", { eventId: "open", status: "BOSS" });
    expect(r).toMatchObject({ ok: false, httpStatus: 400 });
  });

  it("refuses an organizer-side status (WAITLISTED) from a non-canSelfConfirm vendor", async () => {
    const r = await applyVendorTokenPatch(db, "plain", { eventId: "open", status: "WAITLISTED" });
    expect(r).toMatchObject({ ok: false, httpStatus: 403 });
    expect(linkRow("plain", "open")).toBeUndefined();
  });

  it("lets a canSelfConfirm vendor record WAITLISTED (the Cardworks tracker push)", async () => {
    const r = await applyVendorTokenPatch(db, "trusted", { eventId: "open", status: "WAITLISTED" });
    expect(r).toMatchObject({ ok: true, body: { status: "WAITLISTED" } });
  });

  it("refuses REJECTED/CANCELLED even from a canSelfConfirm vendor", async () => {
    for (const status of ["REJECTED", "CANCELLED", "INVITED"]) {
      const r = await applyVendorTokenPatch(db, "trusted", { eventId: "open", status });
      expect(r).toMatchObject({ ok: false, httpStatus: 400 });
    }
    expect(linkRow("trusted", "open")).toBeUndefined();
  });
});

describe("applyVendorTokenPatch — existing application (OPE-1361)", () => {
  it("a non-canSelfConfirm vendor cannot move APPLIED → CONFIRMED (valid transition, wrong actor)", async () => {
    addLink("plain", "open", "APPLIED");
    const r = await applyVendorTokenPatch(db, "plain", { eventId: "open", status: "CONFIRMED" });
    expect(r).toMatchObject({ ok: false, httpStatus: 403 });
    expect(linkRow("plain", "open")?.status).toBe("APPLIED");
  });

  it("a canSelfConfirm vendor can move APPLIED → CONFIRMED", async () => {
    addLink("trusted", "open", "APPLIED");
    const r = await applyVendorTokenPatch(db, "trusted", { eventId: "open", status: "CONFIRMED" });
    expect(r).toMatchObject({ ok: true, body: { status: "CONFIRMED" } });
    expect(linkRow("trusted", "open")?.status).toBe("CONFIRMED");
  });

  it("still enforces VALID_TRANSITIONS (CONFIRMED → APPLIED refused)", async () => {
    addLink("trusted", "open", "CONFIRMED");
    const r = await applyVendorTokenPatch(db, "trusted", { eventId: "open", status: "APPLIED" });
    expect(r).toMatchObject({ ok: false, httpStatus: 400 });
    expect(linkRow("trusted", "open")?.status).toBe("CONFIRMED");
  });

  it("a vendor can withdraw, even from a no-longer-APPROVED event", async () => {
    addLink("plain", "pending", "APPLIED");
    const r = await applyVendorTokenPatch(db, "plain", { eventId: "pending", status: "WITHDRAWN" });
    expect(r).toMatchObject({ ok: true, body: { status: "WITHDRAWN" } });
    expect(linkRow("plain", "pending")?.status).toBe("WITHDRAWN");
  });

  it("re-applying (WITHDRAWN → APPLIED) needs the event to still be APPROVED", async () => {
    addLink("plain", "pending", "WITHDRAWN");
    const r = await applyVendorTokenPatch(db, "plain", { eventId: "pending", status: "APPLIED" });
    expect(r).toMatchObject({ ok: false, httpStatus: 400 });
    expect(linkRow("plain", "pending")?.status).toBe("WITHDRAWN");
  });

  it("refuses a bad paymentStatus on update and leaves the row alone", async () => {
    addLink("plain", "open", "APPLIED");
    const r = await applyVendorTokenPatch(db, "plain", { eventId: "open", paymentStatus: "lol" });
    expect(r).toMatchObject({ ok: false, httpStatus: 400 });
    expect(linkRow("plain", "open")?.paymentStatus).toBe("NOT_REQUIRED");
  });

  it("accepts an enum paymentStatus", async () => {
    addLink("plain", "open", "APPLIED");
    const r = await applyVendorTokenPatch(db, "plain", {
      eventId: "open",
      paymentStatus: "PENDING",
    });
    expect(r).toMatchObject({ ok: true, body: { paymentStatus: "PENDING" } });
    expect(linkRow("plain", "open")?.paymentStatus).toBe("PENDING");
  });

  it("an unverified vendor cannot change an existing row either", async () => {
    addLink("unverified", "open", "APPLIED");
    const r = await applyVendorTokenPatch(db, "unverified", {
      eventId: "open",
      status: "WITHDRAWN",
    });
    expect(r).toMatchObject({ ok: false, error: "email_unverified" });
    expect(linkRow("unverified", "open")?.status).toBe("APPLIED");
  });
});

describe("shared session-route rules", () => {
  it("defaultApplicationStatus follows canSelfConfirm", () => {
    expect(defaultApplicationStatus(false)).toBe("APPLIED");
    expect(defaultApplicationStatus(null)).toBe("APPLIED");
    expect(defaultApplicationStatus(true)).toBe("CONFIRMED");
  });

  it("checkEventAcceptsVendor keeps the session route's messages and codes", () => {
    expect(
      checkEventAcceptsVendor(
        { commercial: false },
        { status: "PENDING", commercialVendorsAllowed: true }
      )
    ).toEqual({
      ok: false,
      httpStatus: 400,
      error: "This event is not currently accepting vendor applications",
    });
    expect(
      checkEventAcceptsVendor(
        { commercial: true },
        { status: "APPROVED", commercialVendorsAllowed: false }
      )
    ).toMatchObject({ ok: false, httpStatus: 403 });
    expect(
      checkEventAcceptsVendor(
        { commercial: true },
        { status: "APPROVED", commercialVendorsAllowed: true }
      )
    ).toEqual({ ok: true });
  });
});
