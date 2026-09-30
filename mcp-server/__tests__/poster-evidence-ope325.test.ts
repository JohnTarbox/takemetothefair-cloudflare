/**
 * OPE-325 review bounce (2026-09-23) — a staged poster left no evidence.
 *
 * Prod: the four PENDING events the poster lane staged in August had ZERO
 * citation rows and a NULL image_url, and a second pass of the Easter Craft
 * Fair poster logged "staged as PENDING event undefined" while resolving to an
 * event that already existed.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { is } from "drizzle-orm";
import * as schema from "../src/schema.js";
import { adminActions, eventDataCitations, events } from "../src/schema.js";
import {
  attachPosterEvidence,
  posterArchiveKey,
  POSTER_CDN_BASE,
  type PosterBucket,
} from "../src/photo/poster-evidence.js";
import { submitEvent } from "../src/email-handlers/submit.js";

function ddlFor(table: Parameters<typeof getTableConfig>[0]): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const type = c.getSQLType().toUpperCase().includes("INT") ? "INTEGER" : "TEXT";
    return `  ${c.name} ${type}${c.primary ? " PRIMARY KEY" : ""}`;
  });
  return `CREATE TABLE ${cfg.name} (\n${cols.join(",\n")}\n);`;
}

let db: any;
beforeEach(() => {
  const raw = new Database(":memory:");
  for (const t of Object.values(schema)) {
    if (is(t, SQLiteTable)) raw.exec(ddlFor(t as never));
  }
  db = drizzle(raw, { schema });
});

function memBucket(seed: Record<string, string>) {
  const store = new Map<string, { body: ArrayBuffer; contentType?: string }>();
  for (const [k, v] of Object.entries(seed)) {
    store.set(k, { body: new TextEncoder().encode(v).buffer as ArrayBuffer });
  }
  const puts: string[] = [];
  const bucket: PosterBucket = {
    async get(k) {
      const o = store.get(k);
      return o ? { arrayBuffer: async () => o.body } : null;
    },
    async head(k) {
      return store.has(k) ? {} : null;
    },
    async put(k, body, opts) {
      puts.push(k);
      store.set(k, { body, contentType: opts.httpMetadata.contentType });
    },
  };
  return { bucket, store, puts };
}

const INBOUND_KEY = "inbound-attachments/CAEv_qqmu11VG5EwD/0-image.png";
const POSTER = { key: INBOUND_KEY, name: "image.png", mimeType: "image/png" };
const OCR =
  "WOMEN'S COLLECTIVE MARKET — Saturday, September 26, 2026 — 10am to 3pm — Town Hall, Winthrop";
const EXTRACTED = {
  url: "",
  event: {
    name: "Women's Collective Market - September",
    startDate: "2026-09-26",
    endDate: "2026-09-26",
    venueName: "Town Hall",
    startTime: "10:00",
    endTime: "15:00",
  },
} as never;

async function seedEvent(id: string, imageUrl: string | null) {
  await db.insert(events).values({
    id,
    name: "Women's Collective Market - September",
    slug: "womens-collective-market-september-2",
    imageUrl,
    status: "PENDING",
  } as never);
}

const run = (bucket: PosterBucket | undefined, eventId = "ea6f7881") =>
  attachPosterEvidence(
    { bucket, db },
    {
      eventId,
      eventName: "Women's Collective Market - September",
      image: POSTER,
      ocrText: OCR,
      inboundId: "ff17aee6-1c3a-4131-90fc-5a2ba1af9bf1",
      fromAddress: "jtarboxme@gmail.com",
      extracted: EXTRACTED,
    }
  );

describe("posterArchiveKey", () => {
  it("lives under the event, is stable per (event, inbound, file), and is URL-safe", () => {
    const k = posterArchiveKey("ea6f7881", "ff17aee6-1c3a", "IMG 2026 (1).JPG");
    expect(k).toBe("events/ea6f7881/posters/ff17aee6-img-2026-1-.jpg");
    expect(posterArchiveKey("ea6f7881", "ff17aee6-1c3a", "IMG 2026 (1).JPG")).toBe(k);
    expect(posterArchiveKey("e", "i", "///")).toBe("events/e/posters/i-poster");
  });
});

describe("attachPosterEvidence — archive, cite, offer", () => {
  it("ACCEPTANCE (item 1): archived copy + citations pointing AT it + a hero proposal", async () => {
    await seedEvent("ea6f7881", null);
    const { bucket, store } = memBucket({ [INBOUND_KEY]: "PNGBYTES" });
    const r = await run(bucket);

    const key = posterArchiveKey("ea6f7881", "ff17aee6-1c3a-4131-90fc-5a2ba1af9bf1", "image.png");
    expect(store.get(key)?.contentType).toBe("image/png");
    expect(r.archivedUrl).toBe(`${POSTER_CDN_BASE}/${key}`);

    const cites = db.select().from(eventDataCitations).all();
    expect(r.citationsInserted).toBe(cites.length);
    expect(cites.length).toBeGreaterThanOrEqual(4);
    expect(new Set(cites.map((c: any) => c.sourceUrl))).toEqual(new Set([r.archivedUrl]));
    expect(cites.every((c: any) => c.sourceType === "user_submitted")).toBe(true);
    expect(cites[0].sourceName).toContain("Poster emailed by jtarboxme@gmail.com");
    expect(cites.find((c: any) => c.fieldName === "start_date")?.value).toBe("2026-09-26");

    expect(r.hero).toBe("proposed");
    const [p] = db.select().from(adminActions).all();
    expect(p.action).toBe("event.hero_proposed");
    const payload = JSON.parse(p.payloadJson);
    expect(payload).toMatchObject({
      photo_key: key,
      would_auto_write: false,
      event_id: "ea6f7881",
    });
  });

  it("NEVER writes events.image_url — the proposal is the only hero path", async () => {
    await seedEvent("ea6f7881", null);
    await run(memBucket({ [INBOUND_KEY]: "x" }).bucket);
    expect(db.select().from(events).all()[0].imageUrl).toBeNull();
  });

  it("ENRICH (item 2): an event that already has an image gets the citations, not a proposal", async () => {
    await seedEvent("55a9d60c", "https://cdn.meetmeatthefair.com/events/55a9d60c/hero.webp");
    const r = await run(memBucket({ [INBOUND_KEY]: "x" }).bucket, "55a9d60c");
    expect(r.citationsInserted).toBeGreaterThan(0);
    expect(r.hero).toBe("event_has_image");
    expect(db.select().from(adminActions).all()).toHaveLength(0);
  });

  it("idempotent under a retry: no second copy, no duplicate citations, no second proposal", async () => {
    await seedEvent("ea6f7881", null);
    const m = memBucket({ [INBOUND_KEY]: "x" });
    await run(m.bucket);
    const again = await run(m.bucket);
    expect(m.puts).toHaveLength(1);
    expect(again.citationsInserted).toBe(0);
    expect(again.hero).toBe("already_proposed");
    expect(db.select().from(adminActions).all()).toHaveLength(1);
  });

  it("a poster that prints NO year cannot be cited for a year-bearing date (OPE-457 guard, fed the OCR)", async () => {
    await seedEvent("ea6f7881", null);
    await attachPosterEvidence(
      { bucket: memBucket({ [INBOUND_KEY]: "x" }).bucket, db },
      {
        eventId: "ea6f7881",
        eventName: "Women's Collective Market - September",
        image: POSTER,
        ocrText: "WOMEN'S COLLECTIVE MARKET — Saturday Sept 26 — 10am to 3pm — Town Hall",
        inboundId: "ff17aee6-1c3a-4131-90fc-5a2ba1af9bf1",
        fromAddress: "jtarboxme@gmail.com",
        extracted: EXTRACTED,
      }
    );
    const fields = db
      .select()
      .from(eventDataCitations)
      .all()
      .map((c: any) => c.fieldName);
    expect(fields).toContain("name");
    expect(fields).not.toContain("start_date");
    expect(fields).not.toContain("end_date");
  });

  it("fail-soft: a missing source object stops before citing (a citation needs a URL that resolves)", async () => {
    await seedEvent("ea6f7881", null);
    const r = await run(memBucket({}).bucket);
    expect(r.archivedUrl).toBeNull();
    expect(r.error).toMatch(/missing/);
    expect(db.select().from(eventDataCitations).all()).toHaveLength(0);
    expect(await run(undefined)).toMatchObject({
      archivedUrl: null,
      error: "no VENDOR_ASSETS binding",
    });
  });
});

describe("submitEvent surfaces what the route did (the `undefined` slug)", () => {
  const env = { MAIN_APP_URL: "https://app.test", INTERNAL_API_KEY: "k" } as never;
  const extracted = { url: "", event: { name: "Easter Craft Fair" } } as never;
  afterEach(() => vi.unstubAllGlobals());

  it("occurrence_exists → routed says so, and no event was created", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          success: true,
          routed: "occurrence_exists",
          event: { id: "55a9d60c", name: "Easter Craft Fair" },
        })
      )
    );
    const r = await submitEvent(env, extracted, "a@b.test", { inboundEmailId: "x" } as never);
    expect(r).toMatchObject({ id: "55a9d60c", routed: "occurrence_exists" });
  });

  it("a plain create reads as created", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ success: true, event: { id: "n1", slug: "s" } }))
    );
    const r = await submitEvent(env, extracted, "a@b.test", { inboundEmailId: "x" } as never);
    expect(r.routed).toBe("created");
  });
});

describe("photo-intake wiring (source) — every resolved outcome carries evidence", () => {
  const src = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/email-handlers/photo-intake.ts"),
    "utf8"
  );
  it("the duplicate path and the submit path both attach evidence; occurrence_exists is a duplicate", () => {
    expect(src.match(/evidence: await evidenceFor\(/g)?.length).toBe(2);
    expect(src).toMatch(/outcome: existed \? "duplicate" : "created"/);
    expect(src).toMatch(
      /stagePosterAsPendingEvent\(env, poster\.text, row, imageRefs\(refs\)\[0\]\)/
    );
  });
});
