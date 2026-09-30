/**
 * OPE-463 review bounce (2026-09-23), two needed items:
 *   1. `inbound_email_events` had 0 rows against 36 emails that created events
 *      — nothing wrote it. submitEvent (the one creation chokepoint) now does.
 *   2. The acceptance's `status='open'` read returned 0 against 6 real
 *      `proposed` rows — OPE-811's vocabulary gap. The read now uses the
 *      canonical fileable set.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { is } from "drizzle-orm";
import * as schema from "../src/schema.js";
import { extractionFaults, inboundEmailEvents } from "../src/schema.js";
import { ALL_FAULT_STATUSES, isFileableStatus } from "../../src/lib/faults/status.js";

function ddlFor(table: Parameters<typeof getTableConfig>[0]): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const type = c.getSQLType().toUpperCase().includes("INT") ? "INTEGER" : "TEXT";
    return `  ${c.name} ${type}${c.primary ? " PRIMARY KEY" : ""}`;
  });
  const idx = cfg.indexes.map((i) => {
    const x = (
      i as unknown as { config: { name: string; unique: boolean; columns: { name: string }[] } }
    ).config;
    return `CREATE ${x.unique ? "UNIQUE " : ""}INDEX ${x.name} ON ${cfg.name} (${x.columns.map((c) => c.name).join(", ")});`;
  });
  return [`CREATE TABLE ${cfg.name} (\n${cols.join(",\n")}\n);`, ...idx].join("\n");
}

const harness = vi.hoisted(() => ({ db: null as any }));
vi.mock("../src/db.js", () => ({ getDb: () => harness.db }));
vi.mock("../src/logger.js", () => ({ logError: vi.fn() }));

const { submitEvent } = await import("../src/email-handlers/submit.js");
const { logError } = await import("../src/logger.js");
const { registerExtractionFaultTools, EXTRACTION_FAULT_FILEABLE_STATUSES } =
  await import("../src/tools/admin-extraction-faults.js");

let db: any;
beforeEach(() => {
  const raw = new Database(":memory:");
  for (const t of Object.values(schema)) if (is(t, SQLiteTable)) raw.exec(ddlFor(t as never));
  harness.db = drizzle(raw, { schema });
  db = harness.db;
});
afterEach(() => vi.unstubAllGlobals());

const ENV = { DB: {}, MAIN_APP_URL: "https://app.test", INTERNAL_API_KEY: "k" } as never;
const EXTRACTED = { url: "", event: { name: "UMF Fall Craft Fair" } } as never;
function routeReturns(...bodies: Record<string, unknown>[]) {
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(bodies[Math.min(i++, bodies.length - 1)]))
  );
}
const links = () => db.select().from(inboundEmailEvents).all();

describe("item 1 — submitEvent records the inbound → event link", () => {
  it("a created event is linked to the email that created it", async () => {
    routeReturns({ success: true, event: { id: "ev-1", slug: "umf" } });
    await submitEvent(ENV, EXTRACTED, "carolyn@x.test", { inboundEmailId: "in-1" } as never);
    expect(links().map((l: any) => [l.inboundEmailId, l.eventId])).toEqual([["in-1", "ev-1"]]);
  });

  it("a FAN-OUT writes one link per created event (what resulting_event_id could never hold)", async () => {
    routeReturns(
      { success: true, event: { id: "ev-1", slug: "a" } },
      { success: true, event: { id: "ev-2", slug: "b" } }
    );
    await submitEvent(ENV, EXTRACTED, "c@x.test", { inboundEmailId: "in-1" } as never);
    await submitEvent(ENV, EXTRACTED, "c@x.test", { inboundEmailId: "in-1" } as never);
    expect(
      links()
        .map((l: any) => l.eventId)
        .sort()
    ).toEqual(["ev-1", "ev-2"]);
  });

  it("occurrence_exists created nothing, so it links nothing", async () => {
    routeReturns({ success: true, routed: "occurrence_exists", event: { id: "ev-old" } });
    await submitEvent(ENV, EXTRACTED, "c@x.test", { inboundEmailId: "in-1" } as never);
    expect(links()).toHaveLength(0);
  });

  it("a Workflow retry is idempotent — still one link", async () => {
    routeReturns({ success: true, event: { id: "ev-1", slug: "umf" } });
    vi.mocked(logError).mockClear();
    await submitEvent(ENV, EXTRACTED, "c@x.test", { inboundEmailId: "in-1" } as never);
    await submitEvent(ENV, EXTRACTED, "c@x.test", { inboundEmailId: "in-1" } as never);
    expect(links()).toHaveLength(1);
    // …and quietly: a retry is expected, not an error. Without the conflict
    // clause the unique index throws, the fail-soft catch logs a warn on every
    // Workflow retry, and the row count alone cannot tell the difference.
    const linkWarns = vi
      .mocked(logError)
      .mock.calls.filter(
        (c) => (c[1] as { source?: string }).source === "submit:inbound-email-events"
      );
    expect(linkWarns).toHaveLength(0);
  });
});

describe("item 2 — the eligibility read sees 'proposed' (OPE-811's canonical set)", () => {
  function fault(signature: string, status: string, opeId: string | null = null) {
    const now = new Date();
    db.insert(extractionFaults)
      .values({
        signature,
        source: "email_submission",
        familyId: signature.split(":").pop(),
        firstSeen: now,
        lastSeen: now,
        count: 1,
        status,
        opeId,
        createdAt: now,
      } as never)
      .run();
  }
  async function list(args: Record<string, unknown> = {}) {
    let handler: any;
    registerExtractionFaultTools(
      { tool: (_n: string, _d: unknown, _s: unknown, h: any) => (handler = h) } as never,
      db,
      { userId: "u", role: "ADMIN" }
    );
    return JSON.parse((await handler({ fileable_only: true, limit: 50, ...args })).content[0].text);
  }

  it("ACCEPTANCE: the prod shape (all 'proposed') is a usable candidate list, not 0", async () => {
    fault("extract.human_reject:email_submission:not-an-event", "proposed");
    fault("extract.human_reject:email_submission:duplicate-of-existing", "proposed");
    fault("extract.human_reject:email_submission:over-split", "proposed");
    const r = await list();
    expect(r.count).toBe(3);
    expect(r.eligibility_sql).toContain("'proposed'");
  });

  it("filed, noise and done rows are not candidates", async () => {
    fault("a:filed", "proposed", "OPE-900");
    fault("a:noise", "noise");
    fault("a:done", "done");
    fault("a:open", "open");
    const r = await list();
    expect(r.faults.map((f: any) => f.signature)).toEqual(["a:open"]);
    expect(r.by_status).toMatchObject({ proposed: 1, noise: 1, done: 1, open: 1 });
  });

  it("the MCP copy of the fileable set equals the main app's isFileableStatus, status by status", () => {
    const copy = new Set<string>(EXTRACTION_FAULT_FILEABLE_STATUSES);
    for (const s of ALL_FAULT_STATUSES) expect(copy.has(s)).toBe(isFileableStatus(s));
  });
});
