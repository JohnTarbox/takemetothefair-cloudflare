/**
 * OPE-651 — `suggest_event` must report the status it actually WROTE.
 *
 * The success return hardcoded `status: "TENTATIVE"` while the row was inserted
 * with `eventStatus`, which is "PENDING" whenever the ingest gates route to
 * review. So a gated create reported TENTATIVE and stored PENDING, and the
 * caller had no way to know the row was off the publication path.
 *
 * That is what produced the report: three events created 26 seconds apart all
 * came back "TENTATIVE", and the one that acquired a gate flag read PENDING
 * afterwards. It LOOKED like a later `update_event` had silently demoted it.
 * It had not — the demotion happened at CREATE and only the report was wrong.
 *
 * The invariant these pin is deliberately not "returns PENDING for a past
 * event" but the stronger, shape-independent one: **reported == stored**.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerVendorTools } from "../src/tools/vendor.js";
import { events, users } from "../src/schema.js";

const AUTH = { userId: "u-submitter", role: "USER" as const };

let db: TestDb;
let server: CapturingMcpServer;

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  db.insert(users).values({ id: "u-submitter", email: "submitter@test", role: "USER" }).run();
  registerVendorTools(server as never, db, AUTH, undefined);
});
afterEach(() => vi.useRealTimers());

interface Payload {
  created: boolean;
  event: { id: string; status: string };
  warnings?: { gate_flags?: string[]; status_note?: string };
}

async function suggest(args: Record<string, unknown>): Promise<Payload> {
  const r = (await server.invoke("suggest_event", args)) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  if (r.isError) throw new Error(`suggest_event failed: ${r.content[0].text}`);
  return JSON.parse(r.content[0].text) as Payload;
}

function storedStatus(id: string): string {
  const [row] = db.select({ status: events.status }).from(events).where(eq(events.id, id)).all();
  return row.status as string;
}

const base = { name: "Test Fair", venue_name: "Somewhere Hall" };

describe("reported status == stored status", () => {
  it("reports PENDING when the gates route a create to review", async () => {
    // A prior-year date — the Cape Cod shape. The row is stored PENDING; the
    // response used to say TENTATIVE.
    const p = await suggest({ ...base, start_date: "2024-01-01", end_date: "2024-01-01" });
    expect(storedStatus(p.event.id)).toBe("PENDING");
    expect(p.event.status).toBe("PENDING");
  });

  it("reports TENTATIVE for an ungated create", async () => {
    const p = await suggest({ ...base, start_date: "2027-07-04", end_date: "2027-07-04" });
    expect(storedStatus(p.event.id)).toBe("TENTATIVE");
    expect(p.event.status).toBe("TENTATIVE");
  });

  it("says WHY the status is not TENTATIVE", async () => {
    // A status the caller did not ask for has to explain itself, or the next
    // reader re-derives it from D1 — which is exactly what this ticket cost.
    const p = await suggest({ ...base, start_date: "2024-01-01", end_date: "2024-01-01" });
    expect(p.warnings?.gate_flags).toContain("end_date_in_past");
    expect(p.warnings?.status_note).toMatch(/PENDING/);
    expect(p.warnings?.status_note).toMatch(/not on the publication path/i);
  });

  it("stays quiet when there is nothing to explain", async () => {
    const p = await suggest({ ...base, start_date: "2027-07-04", end_date: "2027-07-04" });
    expect(p.warnings?.status_note).toBeUndefined();
    expect(p.warnings?.gate_flags).toBeUndefined();
  });
});

describe("an event happening TODAY is not gated (OPE-651 defect B, end to end)", () => {
  it("creates TENTATIVE and reports TENTATIVE on the day of the event", async () => {
    // The reported incident: a car show on 2026-08-30 created that morning.
    // Before the day-comparison fix this stored PENDING and reported TENTATIVE
    // — both halves of this ticket in one call.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T16:11:00Z")); // 12:11 EDT
    const p = await suggest({ ...base, start_date: "2026-08-30", end_date: "2026-08-30" });
    expect(storedStatus(p.event.id)).toBe("TENTATIVE");
    expect(p.event.status).toBe("TENTATIVE");
    expect(p.warnings?.gate_flags).toBeUndefined();
  });
});
