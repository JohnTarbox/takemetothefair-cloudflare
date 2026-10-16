/**
 * OPE-1381 — vendors can no longer set their own paymentStatus on the main-app
 * vendor routes; the organizer-side writers must still work. Pins:
 *   - the event's own promoter can set PAID (promoter `update_application_status`)
 *   - a DIFFERENT promoter cannot
 *   - an admin can set PAID (`update_vendor_status`)
 * Through the real tools against SQLite.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerPromoterTools } from "../src/tools/promoter.js";
import { registerAdminTools } from "../src/tools/admin.js";

let db: TestDb;
let raw: Database.Database;

type Result = { content: Array<{ text: string }>; isError?: boolean };

const payment = () =>
  (
    raw.prepare("SELECT payment_status p FROM event_vendors WHERE id = 'ev1'").get() as {
      p: string;
    }
  ).p;

function promoterServer(promoterId: string) {
  const s = new CapturingMcpServer();
  registerPromoterTools(s as never, db, {
    userId: `u-${promoterId}`,
    role: "PROMOTER",
    promoterId,
  });
  return s;
}

beforeEach(() => {
  ({ db, raw } = createTestDb());
  raw
    .prepare(
      "INSERT INTO promoters (id, company_name, slug) VALUES ('p-own', 'Owner', 'owner'), ('p-other', 'Other', 'other')"
    )
    .run();
  raw
    .prepare(
      "INSERT INTO events (id, name, slug, promoter_id, status) VALUES ('e1', 'Fair', 'fair', 'p-own', 'APPROVED')"
    )
    .run();
  raw
    .prepare(
      "INSERT INTO event_vendors (id, event_id, vendor_id, status, payment_status) VALUES ('ev1', 'e1', 'v1', 'CONFIRMED', 'PENDING')"
    )
    .run();
});

describe("organizer-side paymentStatus writers (OPE-1381)", () => {
  it("the event's promoter can set PAID", async () => {
    const r = (await promoterServer("p-own").invoke("update_application_status", {
      event_slug: "fair",
      vendor_id: "v1",
      payment_status: "PAID",
    })) as Result;
    expect(r.isError).toBeFalsy();
    expect(payment()).toBe("PAID");
  });

  it("a different promoter cannot", async () => {
    const r = (await promoterServer("p-other").invoke("update_application_status", {
      event_slug: "fair",
      vendor_id: "v1",
      payment_status: "PAID",
    })) as Result;
    expect(r.isError).toBe(true);
    expect(payment()).toBe("PENDING");
  });

  it("an admin can set PAID", async () => {
    const s = new CapturingMcpServer();
    registerAdminTools(
      s as never,
      db,
      { userId: "u-admin", role: "ADMIN" } as never,
      { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "k" } as never
    );
    const r = (await s.invoke("update_vendor_status", {
      event_id: "e1",
      vendor_id: "v1",
      payment_status: "PAID",
    })) as Result;
    expect(r.isError).toBeFalsy();
    expect(payment()).toBe("PAID");
  });
});
