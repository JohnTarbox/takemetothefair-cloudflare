/**
 * OPE-227 increment A — the hero PROPOSAL rail.
 *
 * The ruling this rail exists under: "hold every candidate for human review,
 * auto-apply nothing … never write a third-party URL into image_url". So the
 * guard that matters most is the negative one — `events.image_url` is never
 * written — and it is pinned beside a positive landmark (a proposal WAS staged),
 * or a rail that silently did nothing would pass it too.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { is } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { adminActions, events, imageCoverageState } from "@/lib/db/schema";
import {
  HERO_ATTEMPT_ACTION,
  HERO_PROPOSED_ACTION,
  HERO_RESOLVED_ACTION,
  proposeEventHeroes,
  selectHeroCandidates,
  type HeroProposalDeps,
} from "../hero-proposals";

let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

function ddlFor(table: Parameters<typeof getTableConfig>[0]): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const type = c.getSQLType().toUpperCase().includes("INT") ? "INTEGER" : "TEXT";
    return `  ${c.name} ${type}${c.primary ? " PRIMARY KEY" : ""}`;
  });
  return `CREATE TABLE ${cfg.name} (\n${cols.join(",\n")}\n);`;
}

/** D1's batch() is not in the better-sqlite3 driver; run statements in order. */
function withBatch<T extends object>(d: T): T {
  return Object.assign(d, {
    batch: async (stmts: Array<PromiseLike<unknown>>) => {
      const out: unknown[] = [];
      for (const s of stmts) out.push(await s);
      return out;
    },
  });
}

const NOW = new Date("2026-09-16T12:00:00Z");
const DAY = 86_400_000;

beforeEach(() => {
  raw = new Database(":memory:");
  for (const t of Object.values(schema)) {
    if (is(t, SQLiteTable)) raw.exec(ddlFor(t as never));
  }
  db = withBatch(drizzle(raw, { schema }));
});

function seedEvent(
  id: string,
  demand: number,
  over: Partial<{
    status: string;
    imageUrl: string | null;
    sourceUrl: string | null;
    mergedInto: string | null;
    hasImage: boolean;
  }> = {}
) {
  db.insert(events)
    .values({
      id,
      name: `Fair ${id}`,
      slug: `fair-${id}`,
      promoterId: "p1",
      status: over.status ?? "APPROVED",
      imageUrl: over.imageUrl ?? null,
      sourceUrl:
        over.sourceUrl === undefined ? `https://organizer-${id}.example/fair` : over.sourceUrl,
      mergedInto: over.mergedInto ?? null,
    } as never)
    .run();
  db.insert(imageCoverageState)
    .values({
      entityType: "EVENT",
      entityId: id,
      slug: `fair-${id}`,
      hasImage: over.hasImage ?? false,
      demandImpressions: demand,
      firstSeenAt: NOW,
      checkedAt: NOW,
    } as never)
    .run();
}

function seedAction(
  action: string,
  targetType: string,
  targetId: string,
  at: Date,
  id = crypto.randomUUID()
) {
  db.insert(adminActions)
    .values({ id, action, targetType, targetId, createdAt: at, payloadJson: "{}" })
    .run();
  return id;
}

const ids = async (limit = 10) =>
  (await selectHeroCandidates(db as never, limit, NOW)).map((c) => c.id);

describe("selectHeroCandidates", () => {
  it("returns imageless APPROVED events by demand, highest first (positive landmark)", async () => {
    seedEvent("low", 10);
    seedEvent("high", 900);
    seedEvent("mid", 300);
    expect(await ids()).toEqual(["high", "mid", "low"]);
  });

  it.each([
    ["has an image in coverage state", { hasImage: true }],
    ["not APPROVED", { status: "PENDING" }],
    ["merged away", { mergedInto: "keeper" }],
    [
      "already has image_url (live row beats the scan)",
      { imageUrl: "https://cdn.meetmeatthefair.com/events/x.webp" },
    ],
    ["no source_url to look at", { sourceUrl: "" }],
  ])("excludes an event that is %s", async (_label, over) => {
    seedEvent("keep", 1);
    seedEvent("drop", 999, over as never);
    expect(await ids()).toEqual(["keep"]);
  });

  it("excludes an event proposed or attempted within the retry window, and re-offers it after", async () => {
    seedEvent("fresh-attempt", 900);
    seedEvent("fresh-proposal", 800);
    seedEvent("stale-attempt", 700);
    seedEvent("untouched", 1);
    seedAction(HERO_ATTEMPT_ACTION, "event", "fresh-attempt", new Date(NOW.getTime() - 2 * DAY));
    const p = seedAction(
      HERO_PROPOSED_ACTION,
      "event",
      "fresh-proposal",
      new Date(NOW.getTime() - 2 * DAY)
    );
    seedAction(HERO_RESOLVED_ACTION, "admin_action", p, new Date(NOW.getTime() - DAY));
    seedAction(HERO_ATTEMPT_ACTION, "event", "stale-attempt", new Date(NOW.getTime() - 40 * DAY));
    expect(await ids()).toEqual(["stale-attempt", "untouched"]);
  });

  it("never stacks a second proposal on an UNRESOLVED one, however old", async () => {
    seedEvent("pending-old", 900);
    seedEvent("resolved-old", 800);
    seedAction(HERO_PROPOSED_ACTION, "event", "pending-old", new Date(NOW.getTime() - 90 * DAY));
    const r = seedAction(
      HERO_PROPOSED_ACTION,
      "event",
      "resolved-old",
      new Date(NOW.getTime() - 90 * DAY)
    );
    seedAction(HERO_RESOLVED_ACTION, "admin_action", r, new Date(NOW.getTime() - 80 * DAY));
    expect(await ids()).toEqual(["resolved-old"]);
  });

  it("caps a call at 10 even when asked for more", async () => {
    for (let i = 0; i < 14; i++) seedEvent(`e${String(i).padStart(2, "0")}`, 100 + i);
    expect(await ids(50)).toHaveLength(10);
  });
});

describe("proposeEventHeroes", () => {
  const OG = "https://organizer-a.example/wp-content/uploads/2026/fair-poster.jpg";
  const page = (img: string | null) =>
    `<html><head>${img ? `<meta property="og:image" content="${img}">` : ""}<title>Fair</title></head><body>x</body></html>`;

  function fakeDeps(over: Partial<HeroProposalDeps> = {}) {
    const puts: string[] = [];
    const deps: HeroProposalDeps = {
      fetchHtml: async () => page(OG),
      acceptCandidate: async () => ({
        ok: true,
        contentType: "image/jpeg",
        contentLength: 250_000,
        dimensions: { width: 1200, height: 900 },
      }),
      downloadImage: async () => new Uint8Array(250_000).buffer,
      putObject: async (key) => {
        puts.push(key);
      },
      now: () => NOW,
      ...over,
    };
    return { deps, puts };
  }

  const rowsFor = () =>
    raw
      .prepare("SELECT action, target_type, target_id, payload_json FROM admin_actions")
      .all() as Array<{
      action: string;
      target_type: string;
      target_id: string;
      payload_json: string;
    }>;
  const imageUrlOf = (id: string) =>
    (
      raw.prepare("SELECT image_url FROM events WHERE id = ?").get(id) as {
        image_url: string | null;
      }
    ).image_url;

  it("stages a proposal and NEVER writes events.image_url", async () => {
    seedEvent("a", 500);
    const candidates = await selectHeroCandidates(db as never, 10, NOW);
    const { deps, puts } = fakeDeps();

    const out = await proposeEventHeroes(db as never, deps, candidates, new Map(), "internal");

    // Positive landmark: the proposal really was staged.
    expect(out.map((o) => o.outcome)).toEqual(["proposed"]);
    expect(puts).toEqual([`events/a/proposed/og-${NOW.getTime()}.jpg`]);
    const rows = rowsFor();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe(HERO_PROPOSED_ACTION);
    const payload = JSON.parse(rows[0].payload_json);
    expect(payload).toMatchObject({
      photo_class: "event_hero",
      photo_key: puts[0],
      candidate_url: OG,
      would_auto_write: false,
      width: 1200,
      height: 900,
    });
    // The guard.
    expect(imageUrlOf("a")).toBeNull();
    // And it now drops out of selection.
    expect(await ids()).toEqual([]);
  });

  it("records an ATTEMPT (not a proposal) for every page it could not use — one row per candidate", async () => {
    seedEvent("agg", 900, { sourceUrl: "https://aggregator.example/list" });
    seedEvent("nometa", 800);
    seedEvent("gate", 700);
    seedEvent("dl", 600);
    const candidates = await selectHeroCandidates(db as never, 10, NOW);
    const classMap = new Map([
      [
        "aggregator.example",
        { useAsTicketUrl: false, useAsApplicationUrl: false, useAsSource: false },
      ],
    ]);
    const { deps, puts } = fakeDeps({
      fetchHtml: async (u) => (u.includes("organizer-nometa") ? page(null) : page(OG)),
      acceptCandidate: async (u) =>
        candidates.find((c) => c.id === "gate") && u === OG && currentId === "gate"
          ? { ok: false, reason: "too_small", detail: "20000 bytes" }
          : { ok: true, contentType: "image/jpeg", contentLength: 250_000, dimensions: null },
      downloadImage: async () => (currentId === "dl" ? null : new Uint8Array(10).buffer),
    });
    // Track which candidate is in flight so the fakes can fail the right one.
    let currentId = "";
    const origFetch = deps.fetchHtml;
    deps.fetchHtml = async (u) => {
      currentId = candidates.find((c) => c.sourceUrl === u)?.id ?? "";
      return origFetch(u);
    };

    const out = await proposeEventHeroes(db as never, deps, candidates, classMap, "internal");

    expect(Object.fromEntries(out.map((o) => [o.event_id, o.outcome]))).toEqual({
      agg: "skipped_aggregator",
      nometa: "skipped_no_meta",
      gate: "skipped_quality_gate",
      dl: "skipped_download_failed",
    });
    const rows = rowsFor();
    expect(rows).toHaveLength(candidates.length);
    expect(rows.every((r) => r.action === HERO_ATTEMPT_ACTION)).toBe(true);
    expect(puts).toEqual([]);
    // All four are held out of tomorrow's selection.
    expect(await ids()).toEqual([]);
  });

  it("refuses to propose over an image that appeared after selection (the race)", async () => {
    seedEvent("raced", 500);
    const [c] = await selectHeroCandidates(db as never, 10, NOW);
    const { deps, puts } = fakeDeps();
    const out = await proposeEventHeroes(
      db as never,
      deps,
      [{ ...c, imageUrl: "https://cdn.meetmeatthefair.com/events/raced/new.webp" }],
      new Map(),
      "internal"
    );
    expect(out[0].outcome).toBe("skipped_has_image");
    expect(puts).toEqual([]);
  });

  it("an R2 failure is an attempt, not a proposal pointing at nothing", async () => {
    seedEvent("r2", 500);
    const candidates = await selectHeroCandidates(db as never, 10, NOW);
    const { deps } = fakeDeps({
      putObject: async () => {
        throw new Error("R2 down");
      },
    });
    const out = await proposeEventHeroes(db as never, deps, candidates, new Map(), "internal");
    expect(out[0]).toMatchObject({ outcome: "skipped_r2_failed", reason: "R2 down" });
    expect(rowsFor().map((r) => r.action)).toEqual([HERO_ATTEMPT_ACTION]);
  });
});
