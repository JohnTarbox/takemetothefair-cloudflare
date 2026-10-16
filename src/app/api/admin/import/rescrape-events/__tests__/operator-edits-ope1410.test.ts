/**
 * OPE-1410 — rescrape_events never overwrites a field an operator edited after
 * the scraper last wrote it, against a real SQLite.
 *
 * Reproduces event 05d96d95: description edited through MCP on 06-13
 * (admin_actions `event.update` {fields:["description",…], source:"mcp"}), image
 * uploaded through MCP upload_event_image (enrichment_log manual_admin
 * ["image_url"], no admin_actions row), then a rescrape on 06-16 overwrote both.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { eq, is } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { adminActions, enrichmentLog, events } from "@/lib/db/schema";
import { computeOperatorLockedFields, toSyncedField } from "@/lib/scrapers/operator-edited-fields";

let db: ReturnType<typeof drizzle<typeof schema>>;
let details: Record<string, unknown> = {};

function ddlFor(table: Parameters<typeof getTableConfig>[0]): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType().toUpperCase();
    const type = t.includes("INT") ? "INTEGER" : t.includes("REAL") ? "REAL" : "TEXT";
    return `  ${c.name} ${type}${c.primary ? " PRIMARY KEY" : ""}`;
  });
  return `CREATE TABLE ${cfg.name} (\n${cols.join(",\n")}\n);`;
}

vi.mock("@/lib/api-auth", () => ({ isAuthorized: async () => true }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));
vi.mock("@/lib/cloudflare", () => ({ getCloudflareEnv: () => ({}), getCloudflareDb: () => db }));
vi.mock("@/lib/completeness", () => ({ recomputeEventCompleteness: vi.fn() }));
vi.mock("@/lib/url-classification", () => ({
  loadClassifications: async () => [],
  gateUrlForField: (url: string) => url,
}));
vi.mock("@/lib/scrapers/registry", () => ({
  getDetailsScraper: () => async () => details,
}));

const { POST } = await import("../route");

interface RescrapeResult {
  updated: number;
  skipped: number;
  operatorEditedFieldsSkipped: number;
  details: {
    id: string;
    status: string;
    fieldsUpdated?: string[];
    fieldsSkippedOperatorEdited?: string[];
  }[];
}

async function rescrape(ids: string[]): Promise<RescrapeResult> {
  const res = await POST(
    new Request("https://x.test/api/admin/import/rescrape-events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event_ids: ids }),
    })
  );
  expect(res.status).toBe(200);
  return (await res.json()) as RescrapeResult;
}

const row = (id: string) => db.select().from(events).where(eq(events.id, id)).get()!;
const day = (iso: string) => new Date(`${iso}T12:00:00Z`);

const OPERATOR_DESCRIPTION = "Operator-corrected description.";
const OPERATOR_IMAGE = "https://cdn.meetmeatthefair.com/events/e1/hero.jpg";

function operatorEdit(
  fields: string[],
  at: Date,
  source: "mcp" | "admin_ui" = "mcp",
  eventId = "e1"
) {
  db.insert(adminActions)
    .values({
      action: "event.update",
      actorUserId: "admin-user-001",
      targetType: "event",
      targetId: eventId,
      payloadJson: JSON.stringify({ fields, source }),
      createdAt: at,
    } as never)
    .run();
}

function log(source: "scraper" | "manual_admin", fields: string[], at: Date, eventId = "e1") {
  db.insert(enrichmentLog)
    .values({
      targetType: "event",
      targetId: eventId,
      source,
      status: "success",
      attemptedAt: at,
      finishedAt: at,
      fieldsChanged: JSON.stringify(fields),
    } as never)
    .run();
}

beforeEach(() => {
  const raw = new Database(":memory:");
  for (const t of Object.values(schema)) {
    if (is(t, SQLiteTable)) raw.exec(ddlFor(t as never));
  }
  db = drizzle(raw, { schema });
  for (const id of ["e1", "e2"]) {
    db.insert(events)
      .values({
        id,
        name: `Chocolate Festival ${id}`,
        slug: `chocolate-festival-${id}`,
        promoterId: "p1",
        status: "APPROVED",
        description: OPERATOR_DESCRIPTION,
        imageUrl: OPERATOR_IMAGE,
        ticketUrl: "https://festival.example/tickets",
        startDate: day("2026-03-07"),
        endDate: day("2026-03-07"),
        sourceName: "mainemade.com",
        sourceUrl: `https://www.mainemade.com/event/${id}/`,
        syncEnabled: true,
      } as never)
      .run();
  }
  details = {
    description: "Scraped description from the source page.",
    imageUrl: "https://www.mainemade.com/wp-content/uploads/2026/01/hero.jpg",
    startDate: day("2026-03-08"),
    endDate: day("2026-03-08"),
    website: "https://festival.example/tickets",
  };
});

describe("rescrape_events — operator-edited fields (OPE-1410)", () => {
  it("the 05d96d95 shape: MCP description edit + MCP image upload are kept and reported", async () => {
    log("manual_admin", ["image_url"], day("2026-05-07")); // upload_event_image
    operatorEdit(["description", "gate_flags"], day("2026-06-13"));
    log("manual_admin", ["description", "gate_flags"], day("2026-06-13"));

    const res = await rescrape(["e1"]);

    const e = row("e1");
    expect(e.description).toBe(OPERATOR_DESCRIPTION);
    expect(e.imageUrl).toBe(OPERATOR_IMAGE);
    // Fields nobody edited still refresh.
    expect(new Date(e.startDate as Date).toISOString().slice(0, 10)).toBe("2026-03-08");

    const d = res.details[0];
    expect(d.status).toBe("updated");
    expect(d.fieldsUpdated).toEqual(["startDate", "endDate"]);
    expect(d.fieldsSkippedOperatorEdited).toEqual(["description", "imageUrl"]);
    expect(res.operatorEditedFieldsSkipped).toBe(2);
  });

  it("an admin-form edit (camelCase field names) locks the field too", async () => {
    operatorEdit(["imageUrl", "startDate"], day("2026-06-13"), "admin_ui");

    const res = await rescrape(["e1"]);

    const e = row("e1");
    expect(e.imageUrl).toBe(OPERATOR_IMAGE);
    expect(new Date(e.startDate as Date).toISOString().slice(0, 10)).toBe("2026-03-07");
    expect(e.description).toBe("Scraped description from the source page.");
    expect(res.details[0].fieldsSkippedOperatorEdited).toEqual(["startDate", "imageUrl"]);
  });

  it("a scraper write NEWER than the operator edit releases the lock", async () => {
    operatorEdit(["description"], day("2026-06-13"));
    log("scraper", ["description", "imageUrl"], day("2026-06-16"));

    const res = await rescrape(["e1"]);

    expect(row("e1").description).toBe("Scraped description from the source page.");
    expect(res.details[0].fieldsSkippedOperatorEdited).toBeUndefined();
    expect(res.operatorEditedFieldsSkipped).toBe(0);
  });

  it("all changes locked → status skipped, still reports what it withheld", async () => {
    operatorEdit(["description", "image_url", "start_date", "end_date"], day("2026-06-13"));

    const res = await rescrape(["e1"]);

    expect(res.details[0].status).toBe("skipped");
    expect(res.details[0].fieldsSkippedOperatorEdited).toEqual([
      "description",
      "startDate",
      "endDate",
      "imageUrl",
    ]);
    expect(row("e1").description).toBe(OPERATOR_DESCRIPTION);
  });

  it("locks are per event — another event's edit does not protect this one", async () => {
    operatorEdit(["description"], day("2026-06-13"), "mcp", "e2");

    const res = await rescrape(["e1", "e2"]);

    expect(row("e1").description).toBe("Scraped description from the source page.");
    expect(row("e2").description).toBe(OPERATOR_DESCRIPTION);
    const byId = Object.fromEntries(res.details.map((d) => [d.id, d]));
    expect(byId.e1.fieldsSkippedOperatorEdited).toBeUndefined();
    expect(byId.e2.fieldsSkippedOperatorEdited).toEqual(["description"]);
  });

  it("a non-event.update audit row (e.g. event.merge) does not lock anything", async () => {
    db.insert(adminActions)
      .values({
        action: "event.merge",
        targetType: "event",
        targetId: "e1",
        payloadJson: JSON.stringify({ fields: ["description"] }),
        createdAt: day("2026-06-13"),
      } as never)
      .run();

    await rescrape(["e1"]);

    expect(row("e1").description).toBe("Scraped description from the source page.");
  });
});

describe("computeOperatorLockedFields / toSyncedField", () => {
  it("maps both spellings onto the synced-field keys and ignores unsynced fields", () => {
    expect(toSyncedField("image_url")).toBe("imageUrl");
    expect(toSyncedField("imageUrl")).toBe("imageUrl");
    expect(toSyncedField("start_date")).toBe("startDate");
    expect(toSyncedField("gate_flags")).toBeNull();
    expect(toSyncedField(42)).toBeNull();
  });

  it("an edit at the same second as the scraper write stays locked (operator wins ties)", () => {
    const at = day("2026-06-13");
    const locked = computeOperatorLockedFields(
      [{ eventId: "e1", fields: ["description"], at }],
      [{ eventId: "e1", fields: ["description"], at }]
    );
    expect([...(locked.get("e1") ?? [])]).toEqual(["description"]);
  });
});
