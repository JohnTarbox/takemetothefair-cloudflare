/**
 * OPE-517 — an event can hold only one name, so every other name it is known by
 * is unfindable.
 *
 * The Island Arts Association publishes twelve fairs. Dates, venues and hours
 * matched our twelve rows exactly; all twelve NAMES differed. The Oct 10-11
 * fair has three names in circulation at once:
 *
 *   organizer   October Craft Fair at Atlantic Oceanside
 *   chamber     Island Artisans Craft Fair
 *   us          Bar Harbor Fall Craft Fair 2026    (2,359 views)
 *
 * Someone searching the name on the poster does not find the page we already
 * rank for.
 *
 * ⚠️ The ticket's sharpest instruction: this is NOT `set_vendor_alias` ported
 * to events. That is dedup — "this ROW is that row". Events already have
 * `merge_events` for that. This is one surviving row with several names, and
 * the tests below pin that the row is never touched.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerEventNameVariantTools } from "../src/tools/admin-event-name-variants.js";
import { events, promoters } from "../src/schema.js";
import { eq } from "drizzle-orm";

const ADMIN = { userId: "u-admin", role: "ADMIN" as const };
const EVENT_ID = "9a395062-0000-4000-8000-000000000001";
const ORGANIZER_NAME = "October Craft Fair at Atlantic Oceanside";

let db: TestDb;
let server: CapturingMcpServer;

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerEventNameVariantTools(server as never, db, ADMIN as never);
  db.insert(promoters).values({ id: "p-1", companyName: "IAA", slug: "iaa" }).run();
  db.insert(events)
    .values({
      id: EVENT_ID,
      name: "Bar Harbor Fall Craft Fair 2026",
      slug: "bar-harbor-fall-craft-fair-2026",
      promoterId: "p-1",
      status: "APPROVED",
    })
    .run();
});

const parse = (r: unknown) =>
  JSON.parse((r as { content: Array<{ text: string }> }).content[0].text);

const add = (over: Record<string, unknown> = {}) =>
  server.invoke("add_event_name_variant", {
    event_id: EVENT_ID,
    variant: ORGANIZER_NAME,
    variant_type: "organizer_official",
    source_url: "https://islandartsassociation.com/upcoming-fairs",
    ...over,
  });

function readEvent() {
  return db
    .select({
      name: events.name,
      slug: events.slug,
      status: events.status,
      mergedInto: events.mergedInto,
    })
    .from(events)
    .where(eq(events.id, EVENT_ID))
    .get();
}

describe("add_event_name_variant", () => {
  it("records the organizer's name and says the event was not renamed", async () => {
    const out = parse(await add());
    expect(out.ok).toBe(true);
    expect(out.variant).toBe(ORGANIZER_NAME);
    expect(out.canonical_name).toBe("Bar Harbor Fall Craft Fair 2026");
    expect(out.total_variants).toBe(1);
  });

  it("⚠️ does NOT touch name, slug, status or merged_into — read back from the row", async () => {
    // The acceptance criterion that separates this from a rename, and from the
    // dedup tools it must not be confused with. Read from the DB, not from the
    // tool's own echo.
    const before = readEvent();
    await add();
    const after = readEvent();
    expect(after).toEqual(before);
    expect(after?.mergedInto ?? null).toBeNull();
  });

  it("is idempotent — recording the same name twice leaves one variant", async () => {
    await add();
    const out = parse(await add());
    expect(out.total_variants).toBe(1);
  });

  it("refuses to record the canonical name as a variant of itself", async () => {
    // It would score a duplicate hit on every search for that row.
    const out = parse(await add({ variant: "Bar Harbor Fall Craft Fair 2026" }));
    expect(out.ok).toBe(false);
    expect(out.error).toBe("same_as_canonical");
  });

  it("ignores case and surrounding space when deciding that", async () => {
    const out = parse(await add({ variant: "  bar harbor fall craft fair 2026 " }));
    expect(out.error).toBe("same_as_canonical");
  });

  it("keeps several distinct names side by side", async () => {
    await add();
    await add({ variant: "Island Artisans Craft Fair", variant_type: "aggregator" });
    const out = parse(await server.invoke("list_event_name_variants", { event_id: EVENT_ID }));
    expect(out.variants.map((v: { variant: string }) => v.variant).sort()).toEqual([
      "Island Artisans Craft Fair",
      ORGANIZER_NAME,
    ]);
  });

  it("errors on an unknown event rather than writing an orphan", async () => {
    const out = parse(await add({ event_id: "00000000-0000-4000-8000-00000000dead" }));
    expect(out.ok).toBe(false);
    expect(out.error).toBe("event_not_found");
  });
});

describe("list_event_name_variants", () => {
  it("answers 'where did this name come from'", async () => {
    await add();
    const out = parse(await server.invoke("list_event_name_variants", { event_id: EVENT_ID }));
    expect(out.canonical_name).toBe("Bar Harbor Fall Craft Fair 2026");
    expect(out.variants[0].source_url).toBe("https://islandartsassociation.com/upcoming-fairs");
    expect(out.variants[0].variant_type).toBe("organizer_official");
  });

  it("returns an empty list for an event with none", async () => {
    const out = parse(await server.invoke("list_event_name_variants", { event_id: EVENT_ID }));
    expect(out.variants).toEqual([]);
  });
});

describe("remove_event_name_variant", () => {
  it("removes one and leaves the event alone", async () => {
    await add();
    const before = readEvent();
    const out = parse(
      await server.invoke("remove_event_name_variant", {
        event_id: EVENT_ID,
        variant: ORGANIZER_NAME,
      })
    );
    expect(out.ok).toBe(true);
    expect(
      parse(await server.invoke("list_event_name_variants", { event_id: EVENT_ID })).variants
    ).toEqual([]);
    expect(readEvent()).toEqual(before);
  });

  it("reports a miss rather than silently succeeding", async () => {
    const out = parse(
      await server.invoke("remove_event_name_variant", { event_id: EVENT_ID, variant: "nope" })
    );
    expect(out.ok).toBe(false);
    expect(out.error).toBe("variant_not_found");
  });
});

describe("the tools are not dedup, and say so", () => {
  it("the add tool's description points at merge_events instead", async () => {
    // The ticket asked for names that cannot be confused with dedup, because a
    // tool called `set_event_alias` would have invited someone to implement a
    // merge. The description is what an agent reads when choosing between them,
    // so it is the thing that has to say it.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src: string = readFileSync(
      resolve(__dirname, "..", "src", "tools", "admin-event-name-variants.ts"),
      "utf8"
    );
    const desc = src.slice(src.indexOf('"add_event_name_variant"'));
    const firstDesc = desc.slice(0, desc.indexOf("Admin only.") + 12);
    expect(firstDesc).toMatch(/NOT dedup/i);
    expect(firstDesc).toMatch(/merge_events/);
  });
});
