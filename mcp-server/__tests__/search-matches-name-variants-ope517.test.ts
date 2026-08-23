/**
 * OPE-517 scope 3 — the criterion the ticket calls the one that matters:
 *
 *   "search_events (including fuzzy) and the internal site search should hit a
 *    variant as readily as the canonical name. If they don't, the whole feature
 *    is decorative."
 *
 * The acceptance case is literal:
 *
 *   search_events(query: "October Craft Fair at Atlantic Oceanside")
 *     → bar-harbor-fall-craft-fair-2026
 *
 * That is the organizer's own name for the fair, printed on their site and on
 * the poster. Our row is called something else and carries 2,359 views. Before
 * this, the two never met.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerPublicTools } from "../src/tools/public.js";
import { registerEventNameVariantTools } from "../src/tools/admin-event-name-variants.js";
import { events, promoters } from "../src/schema.js";

const ADMIN = { userId: "u-admin", role: "ADMIN" as const };
const EVENT_ID = "9a395062-0000-4000-8000-000000000001";
const ORGANIZER_NAME = "October Craft Fair at Atlantic Oceanside";

let db: TestDb;
let server: CapturingMcpServer;

beforeEach(async () => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerPublicTools(server as never, db);
  registerEventNameVariantTools(server as never, db, ADMIN as never);

  db.insert(promoters).values({ id: "p-1", companyName: "IAA", slug: "iaa" }).run();
  const future = new Date(Date.now() + 30 * 86400_000);
  db.insert(events)
    .values({
      id: EVENT_ID,
      name: "Bar Harbor Fall Craft Fair 2026",
      slug: "bar-harbor-fall-craft-fair-2026",
      promoterId: "p-1",
      status: "APPROVED",
      startDate: future,
      endDate: future,
    })
    .run();
  // A decoy that must not be returned, so a passing test means "found the right
  // row" rather than "returned everything".
  db.insert(events)
    .values({
      id: "9a395062-0000-4000-8000-00000000dec0",
      name: "Skowhegan State Fair 2026",
      slug: "skowhegan-state-fair-2026",
      promoterId: "p-1",
      status: "APPROVED",
      startDate: future,
      endDate: future,
    })
    .run();
});

const parse = (r: unknown) =>
  JSON.parse((r as { content: Array<{ text: string }> }).content[0].text);

const slugsOf = (out: unknown): string[] => {
  const o = out as { events?: Array<{ slug: string }> } | Array<{ slug: string }>;
  const list = Array.isArray(o) ? o : (o.events ?? []);
  return list.map((e) => e.slug);
};

async function addVariant() {
  await server.invoke("add_event_name_variant", {
    event_id: EVENT_ID,
    variant: ORGANIZER_NAME,
    variant_type: "organizer_official",
    source_url: "https://islandartsassociation.com/upcoming-fairs",
  });
}

describe("search_events finds an event by a name variant", () => {
  it("does NOT find it before the variant is recorded — the control", async () => {
    // Without this the test could pass for the wrong reason.
    const out = parse(await server.invoke("search_events", { query: ORGANIZER_NAME }));
    expect(slugsOf(out)).not.toContain("bar-harbor-fall-craft-fair-2026");
  });

  it("finds it by the ORGANIZER's name once recorded (the acceptance case)", async () => {
    await addVariant();
    const out = parse(await server.invoke("search_events", { query: ORGANIZER_NAME }));
    expect(slugsOf(out)).toContain("bar-harbor-fall-craft-fair-2026");
  });

  it("finds it on a partial variant match", async () => {
    await addVariant();
    const out = parse(await server.invoke("search_events", { query: "Atlantic Oceanside" }));
    expect(slugsOf(out)).toContain("bar-harbor-fall-craft-fair-2026");
  });

  it("still finds it by its canonical name — nothing regressed", async () => {
    await addVariant();
    const out = parse(await server.invoke("search_events", { query: "Bar Harbor Fall Craft" }));
    expect(slugsOf(out)).toContain("bar-harbor-fall-craft-fair-2026");
  });

  it("does not start returning unrelated events", async () => {
    await addVariant();
    const out = parse(await server.invoke("search_events", { query: ORGANIZER_NAME }));
    expect(slugsOf(out)).not.toContain("skowhegan-state-fair-2026");
  });

  it("returns the event ONCE even with several variants", async () => {
    // EXISTS rather than a JOIN, for exactly this reason.
    await addVariant();
    await server.invoke("add_event_name_variant", {
      event_id: EVENT_ID,
      variant: "Island Artisans Craft Fair",
      variant_type: "aggregator",
    });
    const out = parse(await server.invoke("search_events", { query: "Craft Fair" }));
    const hits = slugsOf(out).filter((s) => s === "bar-harbor-fall-craft-fair-2026");
    expect(hits).toHaveLength(1);
  });

  it("finds it in FUZZY mode too, where the scorer would otherwise drop it", async () => {
    // The subtle half: a variant-only match can pass the SQL candidate gate and
    // then score 0.0 against the canonical name, so it is filtered before the
    // caller sees it — visible in the candidate set, invisible in the results.
    // The scorer takes the best of name and variants.
    await addVariant();
    const out = parse(
      await server.invoke("search_events", { query: "Atlantic Oceanside Craft", fuzzy: true })
    );
    expect(slugsOf(out)).toContain("bar-harbor-fall-craft-fair-2026");
  });

  it("stops finding it once the variant is removed", async () => {
    await addVariant();
    await server.invoke("remove_event_name_variant", {
      event_id: EVENT_ID,
      variant: ORGANIZER_NAME,
    });
    const out = parse(await server.invoke("search_events", { query: ORGANIZER_NAME }));
    expect(slugsOf(out)).not.toContain("bar-harbor-fall-craft-fair-2026");
  });
});
