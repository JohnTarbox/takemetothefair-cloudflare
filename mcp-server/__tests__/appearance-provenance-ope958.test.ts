/**
 * OPE-958 — an appearance's source can be checked without a re-fetch, and
 * corrected without being overwritten (John, 2026-09-30: supersede, not
 * overwrite).
 *
 *   source_url            acquisition record — never rewritten
 *   last_verified_source  re-verification target — a corrected source supersedes here
 *   source_title/excerpt/content_hash  snapshot of last_verified_source
 *   recheck_state/at/note last re-check outcome
 *
 * Specimens (2026-09-12): Oxford Fair acts citing an orphaned 2024 /schedule/
 * page; The World Famous Grassholes @ Orono Arts Fest citing the band's own
 * rolling homepage. get_performer_data_health reported 0 on both.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { adminActions, eventPerformers, events, performers, promoters } from "../src/schema.js";
import { getPerformerDataHealth, ownSiteKey } from "../src/tools/admin-performer-health.js";
import type { Db } from "../src/db.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const ENV = { MAIN_APP_URL: "https://meetmeatthefair.com", INTERNAL_API_KEY: "test-key" };

let db: TestDb;
let server: CapturingMcpServer;

const parse = (r: unknown) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON tool output, asserted field by field
  JSON.parse((r as { content: Array<{ text: string }> }).content[0].text) as Record<string, any>;
const call = async (name: string, args: Record<string, unknown> = {}) =>
  parse(await server.invoke(name, args));
const appearance = async (id: string) =>
  (await db.select().from(eventPerformers).where(eq(eventPerformers.id, id)))[0];

const HOMEPAGE = "https://worldfamousgrassholes.com/";
const PDF = "https://www.oronoartsfest.com/s/OAF26-Full-Schedule-62526-37yg.pdf";
const EXCERPT = "THE WORLD FAMOUS GRASSHOLES — Sunday, June 28 — 4:00PM — Orono Brewing Company";

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  registerAdminTools(server as never, db, ADMIN_AUTH, ENV as never);
  db.insert(promoters).values({ id: "p1", companyName: "P", slug: "p" }).run();
  db.insert(events)
    .values({
      id: "e1",
      name: "Orono Arts Fest",
      slug: "orono-arts-fest",
      promoterId: "p1",
      status: "APPROVED",
    })
    .run();
  db.insert(performers)
    .values({
      id: "gh",
      name: "The World Famous Grassholes",
      slug: "grassholes",
      website: HOMEPAGE,
    } as never)
    .run();
});

async function linkGrassholes(source: string, extra: Record<string, unknown> = {}) {
  return call("link_performer_to_event", {
    event_id: "e1",
    performer_id: "gh",
    status: "CONFIRMED",
    source_url: source,
    ...extra,
  });
}

describe("snapshot at write time — answerable without a re-fetch", () => {
  it("stores title / excerpt / hash with the appearance and returns them", async () => {
    const r = await linkGrassholes(PDF, {
      source_title: "OAF26 Full Schedule",
      source_excerpt: EXCERPT,
      source_content_hash: "0123456789abcdef",
    });
    expect(r.appearance).toMatchObject({
      source_url: PDF,
      last_verified_source: PDF,
      source_excerpt: EXCERPT,
      source_content_hash: "0123456789abcdef",
    });
    expect(r.appearance.source_fetched_at).toEqual(expect.any(Number));
  });
});

describe("supersede, not overwrite", () => {
  it("a re-call with a DIFFERENT source says so, keeps source_url, and audits the old target", async () => {
    const first = await linkGrassholes(HOMEPAGE, { source_excerpt: "Upcoming Gigs: Jun 28 Orono" });
    const id = first.appearance.id as string;

    const r = await linkGrassholes(PDF, { source_excerpt: EXCERPT });
    expect(r.created_appearance).toBe(false);
    expect(r.verification_source_superseded).toMatchObject({
      acquisition_source_url: HOMEPAGE,
      previous_verification_source: HOMEPAGE,
      verification_source: PDF,
    });

    const row = await appearance(id);
    expect(row.sourceUrl).toBe(HOMEPAGE); // acquisition untouched
    expect(row.lastVerifiedSource).toBe(PDF);
    expect(row.sourceExcerpt).toBe(EXCERPT);

    const audit = await db
      .select()
      .from(adminActions)
      .where(eq(adminActions.action, "performer.link"));
    expect(JSON.parse(audit.at(-1)!.payloadJson!)).toMatchObject({
      superseded_verification_source: HOMEPAGE,
    });
  });

  it("a moved source with NO new snapshot clears the old one — it described a different URL", async () => {
    const { appearance: a } = await linkGrassholes(HOMEPAGE, {
      source_excerpt: "Upcoming Gigs: Jun 28",
    });
    await linkGrassholes(PDF);
    const row = await appearance(a.id);
    expect(row.sourceExcerpt).toBeNull();
    expect(row.sourceFetchedAt).toBeNull();
  });

  it("a re-call with the SAME source is a quiet re-verification (no supersede note)", async () => {
    await linkGrassholes(PDF, { source_excerpt: EXCERPT });
    const r = await linkGrassholes(PDF);
    expect(r).not.toHaveProperty("verification_source_superseded");
    expect(r.appearance.source_excerpt).toBe(EXCERPT); // unchanged source keeps its snapshot
  });
});

describe("record_appearance_recheck — the audited correction route", () => {
  it("confirmed + new source supersedes, stamps verification, and audits the chain", async () => {
    const { appearance: a } = await linkGrassholes(HOMEPAGE);
    const r = await call("record_appearance_recheck", {
      event_performer_id: a.id,
      recheck_state: "confirmed",
      recheck_note: "homepage rolled off; organizer PDF lists the set",
      source_url: PDF,
      source_excerpt: EXCERPT,
    });
    expect(r.verification_source_superseded).toMatchObject({
      previous_verification_source: HOMEPAGE,
    });
    const row = await appearance(a.id);
    expect(row).toMatchObject({
      sourceUrl: HOMEPAGE,
      lastVerifiedSource: PDF,
      recheckState: "confirmed",
      sourceExcerpt: EXCERPT,
    });
    const [audit] = await db
      .select()
      .from(adminActions)
      .where(eq(adminActions.action, "performer.appearance.recheck"));
    expect(JSON.parse(audit.payloadJson!)).toMatchObject({
      acquisition_source_url: HOMEPAGE,
      previous_verification_source: HOMEPAGE,
      superseded_to: PDF,
    });
  });

  it("unreachable records the fact WITHOUT stamping a verification", async () => {
    const { appearance: a } = await linkGrassholes(HOMEPAGE);
    const before = (await appearance(a.id)).lastVerifiedAt;
    await new Promise((r) => setTimeout(r, 1100));
    await call("record_appearance_recheck", {
      event_performer_id: a.id,
      recheck_state: "unreachable",
      recheck_note: "web_fetch refused: provenance-scoped",
    });
    const row = await appearance(a.id);
    expect(row.recheckState).toBe("unreachable");
    expect(row.lastVerifiedAt?.getTime()).toBe(before?.getTime());
  });
});

describe("get_performer_data_health — the checks that reported 0 on both specimens", () => {
  it("ownSiteKey: host without www, social platforms keyed on the account", () => {
    expect(ownSiteKey("https://www.WorldFamousGrassholes.com/gigs")).toBe(
      "worldfamousgrassholes.com"
    );
    expect(ownSiteKey("https://www.facebook.com/SparksArk")).toBe("facebook.com/sparksark");
    expect(ownSiteKey("https://facebook.com/events/123")).toBe("facebook.com/events");
    expect(ownSiteKey("not a url")).toBeNull();
  });

  it("flags the Grassholes row AS IT STOOD on 2026-09-12 (homepage is the re-verification target)", async () => {
    await linkGrassholes(HOMEPAGE);
    const report = await getPerformerDataHealth(db as unknown as Db);
    const check = report.checks.find((c) => c.key === "own_domain_verification_source")!;
    expect(check.count).toBe(1);
    expect(check.findings[0]).toMatchObject({ performer_name: "The World Famous Grassholes" });
  });

  it("clears once a dated asset supersedes it — the state prod is in today", async () => {
    await linkGrassholes(HOMEPAGE);
    await linkGrassholes(PDF);
    const report = await getPerformerDataHealth(db as unknown as Db);
    expect(report.checks.find((c) => c.key === "own_domain_verification_source")!.count).toBe(0);
  });

  it("an organizer's Facebook event is not the act's own Facebook page", async () => {
    db.update(performers)
      .set({ website: "https://www.facebook.com/SparksArk" } as never)
      .where(eq(performers.id, "gh"))
      .run();
    await linkGrassholes("https://www.facebook.com/events/998877");
    const report = await getPerformerDataHealth(db as unknown as Db);
    expect(report.checks.find((c) => c.key === "own_domain_verification_source")!.count).toBe(0);
  });

  it("a CONFIRMED appearance whose last re-check was 'changed' is flagged", async () => {
    const { appearance: a } = await linkGrassholes(PDF);
    await call("record_appearance_recheck", {
      event_performer_id: a.id,
      recheck_state: "changed",
      recheck_note: "schedule now lists a different act at 4pm",
    });
    const report = await getPerformerDataHealth(db as unknown as Db);
    const check = report.checks.find((c) => c.key === "source_recheck_failed")!;
    expect(check.findings).toMatchObject([{ appearance_id: a.id, recheck_state: "changed" }]);
  });
});
