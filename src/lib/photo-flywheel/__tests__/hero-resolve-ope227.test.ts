/**
 * OPE-227 increment B — deciding a staged hero proposal. This is the only path
 * by which the flywheel writes `events.image_url`, so each rule is pinned with
 * the thing it protects: no write, no pipeline run, no decision recorded.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { eq, is } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { adminActions, events } from "@/lib/db/schema";
import { HERO_PROPOSED_ACTION, HERO_RESOLVED_ACTION } from "../hero-proposals";
import { resolveHeroProposal, type HeroResolveDeps } from "../hero-resolve";

let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
const NOW = new Date("2026-09-16T12:00:00Z");
const KEY = "events/e1/proposed/og-1.jpg";

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
  db = drizzle(raw, { schema });
  db.insert(events)
    .values({
      id: "e1",
      name: "Fair",
      slug: "fair",
      promoterId: "p1",
      status: "APPROVED",
      imageUrl: null,
    } as never)
    .run();
  db.insert(adminActions)
    .values({
      id: "prop1",
      action: HERO_PROPOSED_ACTION,
      targetType: "event",
      targetId: "e1",
      createdAt: NOW,
      payloadJson: JSON.stringify({ event_id: "e1", photo_key: KEY, content_type: "image/jpeg" }),
    })
    .run();
});

/** A fake pipeline that does what the real one does to the row it is given. */
function deps(over: Partial<HeroResolveDeps> = {}) {
  const runPipeline = vi.fn(async (args: { targetId: string }) => {
    const url = `https://cdn.meetmeatthefair.com/events/${args.targetId}/hero.webp`;
    db.update(events).set({ imageUrl: url }).where(eq(events.id, args.targetId)).run();
    return { ok: true as const, body: { url, key: "k", content_type: "image/webp" } as never };
  });
  const d: HeroResolveDeps = {
    readObject: vi.fn(async () => ({
      bytes: new Uint8Array([0xff, 0xd8, 0xff]),
      contentType: "image/jpeg",
    })),
    runPipeline: runPipeline as never,
    now: () => NOW,
    ...over,
  };
  return { d, runPipeline };
}

const imageUrl = () =>
  (raw.prepare("SELECT image_url FROM events WHERE id='e1'").get() as { image_url: string | null })
    .image_url;
const resolutions = () =>
  raw
    .prepare(`SELECT payload_json FROM admin_actions WHERE action='${HERO_RESOLVED_ACTION}'`)
    .all() as Array<{ payload_json: string }>;
const decide = (d: HeroResolveDeps, decision: "approve" | "reject", proposalId = "prop1") =>
  resolveHeroProposal(db as never, d, {
    proposalId,
    decision,
    actorId: "admin-1",
    note: "looks right",
  });

describe("resolveHeroProposal", () => {
  it("APPROVE runs the staged bytes through the pipeline and sets image_url (positive landmark)", async () => {
    const { d, runPipeline } = deps();
    const r = await decide(d, "approve");
    expect(r.status).toBe(200);
    expect(runPipeline).toHaveBeenCalledTimes(1);
    expect(runPipeline.mock.calls[0][0]).toMatchObject({
      targetType: "event",
      targetId: "e1",
      declaredType: "image/jpeg",
      uploadSource: "photo-flywheel-approve",
    });
    expect(imageUrl()).toBe("https://cdn.meetmeatthefair.com/events/e1/hero.webp");
    expect(JSON.parse(resolutions()[0].payload_json)).toMatchObject({
      resolution: "approved",
      note: "looks right",
      photo_key: KEY,
    });
  });

  it("REJECT records the decision and writes nothing public", async () => {
    const { d, runPipeline } = deps();
    const r = await decide(d, "reject");
    expect(r).toMatchObject({ status: 200, body: { resolution: "rejected" } });
    expect(runPipeline).not.toHaveBeenCalled();
    expect(imageUrl()).toBeNull();
    expect(resolutions()).toHaveLength(1);
  });

  it("refuses to APPROVE over an image that appeared after staging — no pipeline run, no decision recorded", async () => {
    db.update(events)
      .set({ imageUrl: "https://cdn.meetmeatthefair.com/events/e1/organizer-sent.webp" })
      .where(eq(events.id, "e1"))
      .run();
    const { d, runPipeline } = deps();
    const r = await decide(d, "approve");
    expect(r.status).toBe(409);
    expect(runPipeline).not.toHaveBeenCalled();
    expect(imageUrl()).toBe("https://cdn.meetmeatthefair.com/events/e1/organizer-sent.webp");
    // Left unresolved on purpose, so the operator can still reject it.
    expect(resolutions()).toHaveLength(0);
  });

  it("a proposal is resolved once — a second decision is a 409 and changes nothing", async () => {
    const { d } = deps();
    await decide(d, "reject");
    const { d: d2, runPipeline } = deps();
    const r = await decide(d2, "approve");
    expect(r.status).toBe(409);
    expect(runPipeline).not.toHaveBeenCalled();
    expect(imageUrl()).toBeNull();
    expect(resolutions()).toHaveLength(1);
  });

  it("a missing staged object or a pipeline refusal records no decision", async () => {
    const missing = deps({ readObject: async () => null });
    expect((await decide(missing.d, "approve")).status).toBe(422);
    const refused = deps({
      runPipeline: async () => ({ ok: false, status: 415, body: { error: "bad magic bytes" } }),
    });
    expect((await decide(refused.d, "approve")).status).toBe(502);
    expect(resolutions()).toHaveLength(0);
    expect(imageUrl()).toBeNull();
  });

  it("an unknown id, or a row that is not a hero proposal, is a 404", async () => {
    db.insert(adminActions)
      .values({
        id: "booth1",
        action: "vendor.photo_proposed",
        targetType: "inbound_email",
        targetId: "x",
        createdAt: NOW,
        payloadJson: "{}",
      })
      .run();
    const { d } = deps();
    expect((await decide(d, "approve", "nope")).status).toBe(404);
    expect((await decide(d, "reject", "booth1")).status).toBe(404);
  });
});
