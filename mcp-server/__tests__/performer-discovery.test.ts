/**
 * OPE-116 (2/3) — performer discovery harvest + dedup sweep.
 *
 *   - extractPerformerNodes: JSON-LD performer parsing (array/single/@graph,
 *     type classification, sameAs socials, dedup, malformed input)
 *   - harvestPerformersFromSchemaOrg: dry-run vs live, create + PENDING
 *     appearance, fuzzy-link to existing, idempotency, status='available' gate
 *   - findDuplicatePerformers: pairwise near-dup detection
 */
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import Database from "better-sqlite3";
import { performers, eventPerformers } from "../src/schema.js";
import {
  extractPerformerNodes,
  harvestPerformersFromSchemaOrg,
  findDuplicatePerformers,
} from "../src/tools/admin-performer-discovery.js";

function seedEvent(
  raw: Database.Database,
  id: string,
  over: { sourceUrl?: string | null; name?: string } = {}
) {
  raw
    .prepare(
      "INSERT INTO events (id, name, slug, promoter_id, source_url, status) VALUES (?,?,?,?,?,?)"
    )
    .run(
      id,
      over.name ?? `Event ${id}`,
      `event-${id}`,
      "promo-1",
      over.sourceUrl ?? null,
      "APPROVED"
    );
}

function seedSchemaOrg(
  raw: Database.Database,
  eventId: string,
  jsonLd: unknown,
  status = "available"
) {
  raw
    .prepare(
      "INSERT INTO event_schema_org (id, event_id, raw_json_ld, ticket_url, status) VALUES (?,?,?,?,?)"
    )
    .run(`so-${eventId}`, eventId, JSON.stringify(jsonLd), null, status);
}

async function insertPerformer(db: TestDb, name: string): Promise<string> {
  const id = `perf-${Math.floor(Math.random() * 1e9)}`;
  await db
    .insert(performers)
    .values({ id, name, slug: `slug-${id}` } as never)
    .run();
  return id;
}

// ---------------------------------------------------------------------------
// extractPerformerNodes (pure)
// ---------------------------------------------------------------------------
describe("extractPerformerNodes", () => {
  it("parses a performer array with type + url + sameAs", () => {
    const nodes = extractPerformerNodes(
      JSON.stringify({
        "@type": "Event",
        performer: [
          { "@type": "Person", name: "Magician Mike", url: "https://magicmike.com" },
          {
            "@type": "MusicGroup",
            name: "The Local Legends",
            sameAs: ["https://www.facebook.com/legends", "https://instagram.com/legends"],
          },
        ],
      })
    );
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({
      name: "Magician Mike",
      performerType: "PERSON",
      website: "https://magicmike.com",
    });
    expect(nodes[1].performerType).toBe("GROUP");
    const social = JSON.parse(nodes[1].socialLinks!) as Record<string, string>;
    expect(social.facebook).toBe("https://www.facebook.com/legends");
    expect(social.instagram).toBe("https://instagram.com/legends");
  });

  it("accepts a single performer object (not an array)", () => {
    const nodes = extractPerformerNodes(
      JSON.stringify({ "@type": "Event", performer: { "@type": "Person", name: "Solo Sue" } })
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe("Solo Sue");
  });

  it("finds performers nested under @graph", () => {
    const nodes = extractPerformerNodes(
      JSON.stringify({
        "@graph": [
          { "@type": "Organization", name: "Org" },
          { "@type": "Event", performer: [{ "@type": "Person", name: "Graph Gary" }] },
        ],
      })
    );
    expect(nodes.map((n) => n.name)).toContain("Graph Gary");
  });

  it("dedupes repeat names within one blob (case-insensitive)", () => {
    const nodes = extractPerformerNodes(
      JSON.stringify({
        performer: [{ name: "Repeat Act" }, { name: "repeat act" }],
      })
    );
    expect(nodes).toHaveLength(1);
  });

  it("returns [] on malformed JSON, missing performer, or unusable names", () => {
    expect(extractPerformerNodes("{not json")).toEqual([]);
    expect(extractPerformerNodes(JSON.stringify({ "@type": "Event" }))).toEqual([]);
    expect(extractPerformerNodes(null)).toEqual([]);
    expect(
      extractPerformerNodes(JSON.stringify({ performer: [{ name: "" }, { name: 42 }, { foo: 1 }] }))
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// harvestPerformersFromSchemaOrg (real D1)
// ---------------------------------------------------------------------------
describe("harvestPerformersFromSchemaOrg", () => {
  const twoActs = {
    "@type": "Event",
    performer: [
      { "@type": "Person", name: "Mr. Drew and His Animals Too", url: "https://misterdrew.com" },
      { "@type": "MusicGroup", name: "The Barnyard Band" },
    ],
  };

  it("dry-run reports would-create without writing anything", async () => {
    const { db, raw } = createTestDb();
    seedEvent(raw, "e1", { sourceUrl: "https://fair.example/monmouth" });
    seedSchemaOrg(raw, "e1", twoActs);

    const s = await harvestPerformersFromSchemaOrg(db, null, {}); // dryRun defaults true
    expect(s.dryRun).toBe(true);
    expect(s.rowsScanned).toBe(1);
    expect(s.performerNodesFound).toBe(2);
    expect(s.performersCreated).toHaveLength(2);

    // Nothing written.
    expect(await db.select().from(performers)).toHaveLength(0);
    expect(await db.select().from(eventPerformers)).toHaveLength(0);
  });

  it("live run creates performers + PENDING appearances with source_url provenance", async () => {
    const { db, raw } = createTestDb();
    seedEvent(raw, "e1", { sourceUrl: "https://fair.example/monmouth" });
    seedSchemaOrg(raw, "e1", twoActs);

    const s = await harvestPerformersFromSchemaOrg(db, null, { dryRun: false });
    expect(s.performersCreated).toHaveLength(2);
    expect(s.appearancesCreated).toBe(2);

    const acts = await db.select().from(performers);
    expect(acts).toHaveLength(2);
    const drew = acts.find((a) => a.name.startsWith("Mr. Drew"))!;
    expect(drew.website).toBe("https://misterdrew.com");
    expect(drew.enrichmentSource).toBe("schema_org_harvest");

    const apps = await db.select().from(eventPerformers).where(eq(eventPerformers.eventId, "e1"));
    expect(apps).toHaveLength(2);
    expect(apps.every((a) => a.status === "PENDING")).toBe(true);
    expect(apps.every((a) => a.sourceUrl === "https://fair.example/monmouth")).toBe(true);
  });

  it("fuzzy-links to an existing act instead of creating a duplicate", async () => {
    const { db, raw } = createTestDb();
    const existing = await insertPerformer(db, "Mr. Drew and His Animals Too");
    seedEvent(raw, "e1");
    seedSchemaOrg(raw, "e1", {
      performer: [{ "@type": "Person", name: "Mr. Drew and His Animals Too" }],
    });

    const s = await harvestPerformersFromSchemaOrg(db, null, { dryRun: false });
    expect(s.performersCreated).toHaveLength(0);
    expect(s.performersLinked).toHaveLength(1);
    expect(await db.select().from(performers)).toHaveLength(1);
    const [app] = await db.select().from(eventPerformers);
    expect(app.performerId).toBe(existing);
  });

  it("is idempotent — a second live run adds no duplicate appearances", async () => {
    const { db, raw } = createTestDb();
    seedEvent(raw, "e1");
    seedSchemaOrg(raw, "e1", twoActs);

    await harvestPerformersFromSchemaOrg(db, null, { dryRun: false });
    const s2 = await harvestPerformersFromSchemaOrg(db, null, { dryRun: false });
    expect(s2.performersCreated).toHaveLength(0); // fuzzy-linked to run-1's acts
    expect(s2.appearancesCreated).toBe(0);
    expect(s2.appearancesExisting).toBe(2);
    expect(await db.select().from(eventPerformers)).toHaveLength(2);
  });

  it("only scans status='available' schema-org rows", async () => {
    const { db, raw } = createTestDb();
    seedEvent(raw, "e1");
    seedSchemaOrg(raw, "e1", twoActs, "pending");

    const s = await harvestPerformersFromSchemaOrg(db, null, { dryRun: false });
    expect(s.rowsScanned).toBe(0);
    expect(s.performersCreated).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// findDuplicatePerformers
// ---------------------------------------------------------------------------
describe("findDuplicatePerformers", () => {
  it("surfaces a near-duplicate pair", async () => {
    const { db } = createTestDb();
    await insertPerformer(db, "The Smith Family Band");
    await insertPerformer(db, "The Smith Family Band!");
    await insertPerformer(db, "Completely Different Act");

    const { pairs } = await findDuplicatePerformers(db, { minScore: 0.85 });
    expect(pairs.length).toBeGreaterThanOrEqual(1);
    const names = [pairs[0].a.name, pairs[0].b.name].sort();
    expect(names).toEqual(["The Smith Family Band", "The Smith Family Band!"]);
    expect(pairs[0].score).toBeGreaterThanOrEqual(0.85);
  });

  it("returns no pairs when acts are distinct", async () => {
    const { db } = createTestDb();
    await insertPerformer(db, "Alpha Act");
    await insertPerformer(db, "Zeta Zephyr Zoo");
    const { pairs } = await findDuplicatePerformers(db, { minScore: 0.85 });
    expect(pairs).toHaveLength(0);
  });
});
