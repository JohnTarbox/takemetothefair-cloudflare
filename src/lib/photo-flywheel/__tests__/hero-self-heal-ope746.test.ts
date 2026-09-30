/**
 * OPE-746 — self-heal of a DEAD event hero through the OPE-227 proposal rail.
 *
 * The rail used to fill empty slots only. A slot whose image the rot sweep
 * confirmed dead is broken on the page already, so it now qualifies too — but
 * under three guards, each pinned here beside a positive landmark:
 *  1. selection keys on the live `image_url` EQUALLING the swept dead URL;
 *  2. proposing never writes `events.image_url` (unchanged rail rule);
 *  3. approval compare-and-swaps on that URL AND re-probes it — an image that
 *     loads now is not replaced (the sweep flagged 8 live images on 09-25).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { eq, is } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { adminActions, events, imageCoverageState } from "@/lib/db/schema";
import {
  HERO_PROPOSED_ACTION,
  proposeEventHeroes,
  selectHeroCandidates,
  type HeroProposalDeps,
} from "../hero-proposals";
import { resolveHeroProposal, type HeroResolveDeps } from "../hero-resolve";

let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
const NOW = new Date("2026-09-26T12:00:00Z");
const DEAD = "https://organizer.example/wp-content/uploads/gone.jpg";
const OG = "https://organizer-e1.example/og.jpg";

function ddlFor(table: Parameters<typeof getTableConfig>[0]): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const type = c.getSQLType().toUpperCase().includes("INT") ? "INTEGER" : "TEXT";
    return `  ${c.name} ${type}${c.primary ? " PRIMARY KEY" : ""}`;
  });
  return `CREATE TABLE ${cfg.name} (\n${cols.join(",\n")}\n);`;
}

beforeEach(() => {
  raw = new Database(":memory:");
  for (const t of Object.values(schema)) if (is(t, SQLiteTable)) raw.exec(ddlFor(t as never));
  db = Object.assign(drizzle(raw, { schema }), {
    batch: async (stmts: Array<PromiseLike<unknown>>) => {
      const out: unknown[] = [];
      for (const s of stmts) out.push(await s);
      return out;
    },
  });
});

function seed(
  id: string,
  opts: { imageUrl: string | null; urlHealth: string; sweptUrl: string | null; status?: number }
) {
  db.insert(events)
    .values({
      id,
      name: `Fair ${id}`,
      slug: `fair-${id}`,
      promoterId: "p1",
      status: "APPROVED",
      imageUrl: opts.imageUrl,
      sourceUrl: `https://organizer-${id}.example/fair`,
    } as never)
    .run();
  db.insert(imageCoverageState)
    .values({
      entityType: "EVENT",
      entityId: id,
      slug: `fair-${id}`,
      hasImage: opts.sweptUrl != null,
      imageUrl: opts.sweptUrl,
      urlHealth: opts.urlHealth,
      urlStatusCode: opts.status ?? null,
      demandImpressions: 100,
      firstSeenAt: NOW,
      checkedAt: NOW,
    } as never)
    .run();
}

const imageUrlOf = (id: string) =>
  (raw.prepare("SELECT image_url FROM events WHERE id = ?").get(id) as { image_url: string | null })
    .image_url;

describe("selectHeroCandidates — dead heroes", () => {
  it("offers an event whose live image_url is the URL the sweep found dead", async () => {
    seed("dead", { imageUrl: DEAD, urlHealth: "UNREACHABLE", sweptUrl: DEAD, status: 404 });
    const [c] = await selectHeroCandidates(db as never, 10, NOW);
    expect(c).toMatchObject({ id: "dead", deadImageUrl: DEAD, deadStatusCode: 404 });
  });

  it.each([
    [
      "the image changed since the sweep",
      {
        imageUrl: "https://cdn.meetmeatthefair.com/new.webp",
        urlHealth: "UNREACHABLE",
        sweptUrl: DEAD,
      },
    ],
    ["the image is healthy (OWNED)", { imageUrl: DEAD, urlHealth: "OWNED", sweptUrl: DEAD }],
    [
      "the image is hotlinked but loads",
      { imageUrl: DEAD, urlHealth: "HOTLINKED", sweptUrl: DEAD },
    ],
  ])("does NOT offer an event when %s", async (_l, opts) => {
    seed("empty", { imageUrl: null, urlHealth: "MISSING", sweptUrl: null });
    seed("x", opts);
    expect((await selectHeroCandidates(db as never, 10, NOW)).map((c) => c.id)).toEqual(["empty"]);
  });
});

describe("proposeEventHeroes — dead heroes", () => {
  const page = `<html><head><meta property="og:image" content="${OG}"></head></html>`;
  const deps: HeroProposalDeps = {
    fetchHtml: async () => page,
    acceptCandidate: async () => ({
      ok: true,
      contentType: "image/jpeg",
      contentLength: 250_000,
      dimensions: { width: 1200, height: 900 },
    }),
    downloadImage: async () => new Uint8Array(250_000).buffer,
    putObject: async () => {},
    now: () => NOW,
  };

  it("stages a proposal that records the dead URL, and does not touch image_url", async () => {
    seed("e1", { imageUrl: DEAD, urlHealth: "UNREACHABLE", sweptUrl: DEAD, status: 403 });
    const candidates = await selectHeroCandidates(db as never, 10, NOW);
    const out = await proposeEventHeroes(db as never, deps, candidates, new Map(), "internal");
    expect(out.map((o) => o.outcome)).toEqual(["proposed"]);
    const row = raw.prepare("SELECT payload_json FROM admin_actions").get() as {
      payload_json: string;
    };
    expect(JSON.parse(row.payload_json)).toMatchObject({
      replaces_dead_url: DEAD,
      dead_status_code: 403,
      would_auto_write: false,
    });
    expect(imageUrlOf("e1")).toBe(DEAD);
  });

  it("still refuses a non-empty image that is NOT the recorded dead URL", async () => {
    seed("e1", { imageUrl: DEAD, urlHealth: "UNREACHABLE", sweptUrl: DEAD });
    const [c] = await selectHeroCandidates(db as never, 10, NOW);
    const out = await proposeEventHeroes(
      db as never,
      deps,
      [{ ...c, imageUrl: "https://cdn.meetmeatthefair.com/events/e1/new.webp" }],
      new Map(),
      "internal"
    );
    expect(out[0].outcome).toBe("skipped_has_image");
  });
});

describe("resolveHeroProposal — replacing a dead hero", () => {
  function stage(replaces: string | null, live: string | null) {
    db.insert(events)
      .values({
        id: "e1",
        name: "Fair",
        slug: "fair",
        promoterId: "p1",
        status: "APPROVED",
        imageUrl: live,
      } as never)
      .run();
    db.insert(adminActions)
      .values({
        id: "prop1",
        action: HERO_PROPOSED_ACTION,
        targetType: "event",
        targetId: "e1",
        createdAt: NOW,
        payloadJson: JSON.stringify({
          event_id: "e1",
          photo_key: "events/e1/proposed/og-1.jpg",
          content_type: "image/jpeg",
          replaces_dead_url: replaces,
        }),
      })
      .run();
  }
  function deps(probe?: (u: string) => Promise<boolean>) {
    const runPipeline = vi.fn(async (args: { targetId: string }) => {
      const url = `https://cdn.meetmeatthefair.com/events/${args.targetId}/hero.webp`;
      db.update(events).set({ imageUrl: url }).where(eq(events.id, args.targetId)).run();
      return { ok: true as const, body: { url, key: "k", content_type: "image/webp" } as never };
    });
    const d: HeroResolveDeps = {
      readObject: async () => ({
        bytes: new Uint8Array([0xff, 0xd8, 0xff]),
        contentType: "image/jpeg",
      }),
      runPipeline: runPipeline as never,
      ...(probe ? { probeUrl: probe } : {}),
      now: () => NOW,
    };
    return { d, runPipeline };
  }
  const approve = (d: HeroResolveDeps) =>
    resolveHeroProposal(db as never, d, {
      proposalId: "prop1",
      decision: "approve",
      actorId: "admin",
    });

  it("replaces the dead URL when a fresh probe confirms it still does not load (positive landmark)", async () => {
    stage(DEAD, DEAD);
    const { d, runPipeline } = deps(async () => false);
    const res = await approve(d);
    expect(res.status).toBe(200);
    expect(runPipeline).toHaveBeenCalledOnce();
    expect(imageUrlOf("e1")).toBe("https://cdn.meetmeatthefair.com/events/e1/hero.webp");
  });

  it("refuses when the 'dead' image loads now — never replace a working image", async () => {
    stage(DEAD, DEAD);
    const { d, runPipeline } = deps(async () => true);
    expect((await approve(d)).status).toBe(409);
    expect(runPipeline).not.toHaveBeenCalled();
    expect(imageUrlOf("e1")).toBe(DEAD);
  });

  it("refuses when no probe is wired (cannot confirm dead)", async () => {
    stage(DEAD, DEAD);
    const { d, runPipeline } = deps();
    expect((await approve(d)).status).toBe(409);
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it("refuses when the live image changed since the proposal was staged", async () => {
    const replaced = "https://cdn.meetmeatthefair.com/events/e1/organizer-sent.webp";
    stage(DEAD, replaced);
    const probe = vi.fn(async () => false);
    const { d, runPipeline } = deps(probe);
    expect((await approve(d)).status).toBe(409);
    expect(runPipeline).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    expect(imageUrlOf("e1")).toBe(replaced);
  });
});
