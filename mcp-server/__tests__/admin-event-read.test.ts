import { describe, expect, it, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import { registerAdminEventReadTools } from "../src/tools/admin-event-read.js";
import { events } from "../src/schema.js";

/**
 * OPE-500 — the public reader filters to APPROVED, which is inverted relative to
 * need: PENDING rows are the ones a reviewer is asked to judge, and those are
 * the ones it refused with "Event not found".
 */
function collect() {
  const tools = new Map<string, (a: never) => Promise<{ content: Array<{ text: string }> }>>();
  const server = {
    tool: (n: string, _d: string, _s: unknown, cb: (a: never) => Promise<never>) =>
      void tools.set(n, cb as never),
  } as never;
  return { server, tools };
}

let db: TestDb;
let tools: ReturnType<typeof collect>["tools"];

async function call(args: unknown) {
  const res = await tools.get("get_event_details_admin")!(args as never);
  return JSON.parse(res.content[0].text);
}

beforeEach(async () => {
  ({ db } = createTestDb());
  const c = collect();
  registerAdminEventReadTools(c.server, db as never, { role: "ADMIN", userId: "u" } as never);
  tools = c.tools;

  await db.insert(events).values({
    id: "ev-pending",
    name: "Women's Collective Market September",
    slug: "womens-collective-market-september",
    description: "A market.",
    status: "PENDING",
    lifecycleStatus: "SCHEDULED",
    promoterId: "p1",
    startDate: new Date("2026-09-01T00:00:00Z"),
    endDate: new Date("2026-09-30T00:00:00Z"),
    datesConfirmed: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as never);
});

describe("get_event_details_admin (OPE-500)", () => {
  it("returns a PENDING row — the case the public reader calls 'not found'", async () => {
    const out = await call({ slug: "womens-collective-market-september" });
    expect(out.status).toBe("PENDING");
    expect(out.name).toContain("Women's Collective Market");
    expect(out.description).toBe("A market.");
  });

  it("marks clearly that the row is NOT publicly visible", async () => {
    // The risk of a status-agnostic reader is a caller mistaking an
    // un-adjudicated row for a live one.
    const out = await call({ slug: "womens-collective-market-september" });
    expect(out.is_publicly_visible).toBe(false);
  });

  it("accepts a UUID as well as a slug", async () => {
    const bySlug = await call({ slug: "womens-collective-market-september" });
    const byId = await call({ event_id: "ev-pending" });
    expect(byId.id).toBe(bySlug.id);
    expect(byId.slug).toBe(bySlug.slug);
  });

  it("exposes dates_confirmed and RAW ISO dates, not only a rendered string", async () => {
    // OPE-482: MCP shares the site's formatter, so a formatted date read back is
    // not an independent check of the stored column.
    const out = await call({ event_id: "ev-pending" });
    expect(out.dates_confirmed).toBe(false);
    expect(out.start_date).toBe("2026-09-01T00:00:00.000Z");
    expect(out.end_date).toBe("2026-09-30T00:00:00.000Z");
  });

  it("distinguishes a genuinely absent row and says the filter is not the cause", async () => {
    const out = await call({ slug: "no-such-event-anywhere" });
    expect(out.error).toBe("event_not_found");
    expect(out.detail).toMatch(/does not filter by status/i);
  });

  it("requires one of slug or event_id", async () => {
    const out = await call({});
    expect(out.error).toBe("slug_or_event_id_required");
  });

  it("is admin-gated", () => {
    const c = collect();
    registerAdminEventReadTools(c.server, db as never, { role: "PROMOTER", userId: "x" } as never);
    expect(c.tools.size).toBe(0);
  });
});
