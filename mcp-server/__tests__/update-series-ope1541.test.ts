/**
 * OPE-1541 — update_series: the series rename is one atomic write that carries
 * its own redirect, or it writes nothing.
 *
 * The redirect itself (old URL → 301 → new) is asserted end-to-end against the
 * real middleware in src/__tests__/update-series-redirects-ope1541.test.ts.
 * This file pins the rows: what is written, what is refused, and that a dry run
 * writes zero rows.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb, CapturingMcpServer, type TestDb } from "./setup-db.js";
import {
  handleUpdateSeries,
  planSeriesUpdate,
  registerUpdateSeriesTool,
  type SeriesRow,
} from "../src/tools/admin-update-series.js";
import type { AuthContext } from "../src/auth.js";

let db: TestDb;
let raw: Database.Database;
const admin = { userId: "admin-1" };

beforeEach(() => {
  ({ db, raw } = createTestDb());
  raw.prepare(`INSERT INTO promoters (id, company_name, slug) VALUES ('p1', 'GAHS', 'gahs')`).run();
  seedSeries("s1", "gahs-interact-club-spring-craft-fair", "GAHS Interact Club Spring Craft Fair");
});
afterEach(() => raw.close());

function seedSeries(id: string, slug: string, name: string) {
  raw
    .prepare(
      `INSERT INTO event_series (id, canonical_slug, name, promoter_id, updated_at) VALUES (?, ?, ?, 'p1', 1700000000)`
    )
    .run(id, slug, name);
}
const series = (id = "s1") =>
  raw
    .prepare(
      "SELECT canonical_slug slug, name, description, tags, updated_at u FROM event_series WHERE id = ?"
    )
    .get(id) as { slug: string; name: string; description: string | null; tags: string; u: number };
const history = () =>
  raw
    .prepare(
      "SELECT old_slug o, new_slug n, series_id s, changed_by b FROM series_slug_history ORDER BY old_slug"
    )
    .all() as Array<{ o: string; n: string; s: string; b: string | null }>;
const count = (table: string) =>
  (raw.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n;
const pings = () =>
  raw
    .prepare("SELECT entity_type t, entity_slug s FROM pending_search_pings ORDER BY entity_slug")
    .all();

/** Every table a rename can write, so "nothing written" is checked everywhere. */
const writes = () => ({
  history: count("series_slug_history"),
  audits: count("admin_actions"),
  pings: count("pending_search_pings"),
  series: JSON.stringify(series()),
});

describe("update_series: dry run", () => {
  it("is the default and writes zero rows, while still reporting the plan", async () => {
    const before = writes();
    const r = await handleUpdateSeries(db, admin, {
      series_id: "s1",
      name: "GAHS Interact Club Craft Fair",
      slug: "gahs-interact-club-craft-fair",
      reason: "multi-edition now",
    });
    expect(r).toMatchObject({
      applied: false,
      dry_run: true,
      slug_after: "gahs-interact-club-craft-fair",
      changes: { name: { to: "GAHS Interact Club Craft Fair" } },
      redirect: {
        writes_history_row: "gahs-interact-club-spring-craft-fair → gahs-interact-club-craft-fair",
      },
      problems: [],
    });
    expect(writes()).toEqual(before);
  });
});

describe("update_series: rename with slug", () => {
  it("writes the history row, the fields, the audit and both pings in one apply", async () => {
    const r = await handleUpdateSeries(db, admin, {
      series_id: "s1",
      name: "GAHS Interact Club Craft Fair",
      slug: "gahs-interact-club-craft-fair",
      description: "Spring and December.",
      tags: ["crafts", "holiday"],
      reason: "multi-edition now",
      dry_run: false,
    });
    expect(r).toMatchObject({ applied: true, dry_run: false });
    const s = series();
    expect(s).toMatchObject({
      slug: "gahs-interact-club-craft-fair",
      name: "GAHS Interact Club Craft Fair",
      description: "Spring and December.",
      tags: '["crafts","holiday"]',
    });
    // updated_at moves, which is what changes the occurrence pages' ETag.
    expect(s.u).toBeGreaterThan(1700000000);
    expect(history()).toEqual([
      {
        o: "gahs-interact-club-spring-craft-fair",
        n: "gahs-interact-club-craft-fair",
        s: "s1",
        b: "admin-1",
      },
    ]);
    const audit = raw
      .prepare("SELECT action, target_id, payload_json p FROM admin_actions")
      .get() as { action: string; target_id: string; p: string };
    expect(audit.action).toBe("series.update");
    expect(audit.target_id).toBe("s1");
    expect(JSON.parse(audit.p).reason).toBe("multi-edition now");
    expect(pings()).toEqual([
      { t: "event", s: "gahs-interact-club-craft-fair" },
      { t: "event", s: "gahs-interact-club-spring-craft-fair" },
    ]);
  });

  it("A→B then B→C stores A→C and B→C, so every retired slug is one hop from the live one", async () => {
    await handleUpdateSeries(db, admin, {
      series_id: "s1",
      slug: "b-fair",
      reason: "1",
      dry_run: false,
    });
    const r = await handleUpdateSeries(db, admin, {
      series_id: "s1",
      slug: "c-fair",
      reason: "2",
      dry_run: false,
    });
    expect(r).toMatchObject({
      redirect: { repoints_earlier_slugs: ["gahs-interact-club-spring-craft-fair"] },
    });
    expect(history().map((h) => `${h.o}→${h.n}`)).toEqual([
      "b-fair→c-fair",
      "gahs-interact-club-spring-craft-fair→c-fair",
    ]);
  });

  it("renaming BACK to its own retired slug reclaims it without leaving a loop", async () => {
    await handleUpdateSeries(db, admin, {
      series_id: "s1",
      slug: "b-fair",
      reason: "1",
      dry_run: false,
    });
    const r = await handleUpdateSeries(db, admin, {
      series_id: "s1",
      slug: "gahs-interact-club-spring-craft-fair",
      reason: "undo",
      dry_run: false,
    });
    expect(r).toMatchObject({ applied: true, redirect: { reclaims_own_retired_slug: true } });
    expect(series().slug).toBe("gahs-interact-club-spring-craft-fair");
    expect(history().map((h) => `${h.o}→${h.n}`)).toEqual([
      "b-fair→gahs-interact-club-spring-craft-fair",
    ]);
  });
});

describe("update_series: refusals write nothing", () => {
  const refuse = async (slug: string, problem: RegExp) => {
    const before = writes();
    const r = await handleUpdateSeries(db, admin, {
      series_id: "s1",
      name: "Renamed",
      slug,
      reason: "x",
      dry_run: false,
    });
    expect(r.applied).toBe(false);
    expect((r.problems as string[]).join(" | ")).toMatch(problem);
    expect(writes()).toEqual(before);
  };

  it("another series already has the slug", async () => {
    seedSeries("s2", "taken-fair", "Taken");
    await refuse("taken-fair", /canonical slug of series s2/);
  });

  it("another series retired the slug (its old URL redirects there)", async () => {
    seedSeries("s2", "other-fair", "Other");
    raw
      .prepare(
        "INSERT INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at) VALUES ('h', 's2', 'old-other', 'other-fair', 1)"
      )
      .run();
    await refuse("old-other", /retired slug of series s2/);
  });

  it("an event has the slug: /events/<slug> serves the event before any hub", async () => {
    raw
      .prepare(
        "INSERT INTO events (id, name, slug, promoter_id, status) VALUES ('e1', 'Show', 'some-show', 'p1', 'APPROVED')"
      )
      .run();
    await refuse("some-show", /slug of event e1/);
  });

  it("an event retired the slug", async () => {
    raw
      .prepare(
        "INSERT INTO event_slug_history (id, event_id, old_slug, new_slug, changed_at) VALUES ('eh', 'e9', 'old-show', 'new-show', 1)"
      )
      .run();
    await refuse("old-show", /retired event slug \(event e9\)/);
  });

  it("a non-canonical slug", async () => {
    await refuse("Bad Slug!", /not canonical/);
    await refuse("double--hyphen", /not canonical/);
  });

  it("an unknown series", async () => {
    const r = await handleUpdateSeries(db, admin, {
      series_id: "nope",
      reason: "x",
      dry_run: false,
    });
    expect(r).toMatchObject({ applied: false, error: "series_not_found" });
  });
});

describe("update_series: name-only and no-op", () => {
  it("a name change keeps the slug and writes no history row", async () => {
    await handleUpdateSeries(db, admin, {
      series_id: "s1",
      name: "GAHS Interact Club Craft Fair",
      reason: "cosmetic",
      dry_run: false,
    });
    expect(series()).toMatchObject({
      slug: "gahs-interact-club-spring-craft-fair",
      name: "GAHS Interact Club Craft Fair",
    });
    expect(count("series_slug_history")).toBe(0);
    expect(pings()).toEqual([{ t: "event", s: "gahs-interact-club-spring-craft-fair" }]);
  });

  it("passing the current values reports no_changes and writes nothing", async () => {
    const before = writes();
    const r = await handleUpdateSeries(db, admin, {
      series_id: "s1",
      name: "GAHS Interact Club Spring Craft Fair",
      slug: "gahs-interact-club-spring-craft-fair",
      reason: "x",
      dry_run: false,
    });
    expect(r).toMatchObject({ applied: false, no_changes: true });
    expect(writes()).toEqual(before);
  });
});

describe("planSeriesUpdate (pure)", () => {
  const row: SeriesRow = {
    id: "s",
    canonicalSlug: "a",
    name: "A",
    description: null,
    imageUrl: null,
    categories: "[]",
    tags: "[]",
  };
  it("refuses a blank name", () => {
    expect(planSeriesUpdate(row, { name: "   " }).problems).toEqual(["name is blank"]);
  });
  it("refuses a category outside EVENT_CATEGORIES (OPE-1058), and accepts one inside", () => {
    expect(planSeriesUpdate(row, { categories: ["Craft Fsir"] }).problems).toEqual([
      "categories not in EVENT_CATEGORIES: Craft Fsir",
    ]);
    const ok = planSeriesUpdate(row, { categories: ["Craft Fair"] });
    expect(ok.problems).toEqual([]);
    expect(ok.changes.categories).toEqual({ from: "[]", to: '["Craft Fair"]' });
  });
  it("clears a description with null, and ignores unchanged tags", () => {
    const p = planSeriesUpdate({ ...row, description: "x" }, { description: null, tags: [] });
    expect(p.changes).toEqual({ description: { from: "x", to: null } });
  });
});

describe("update_series (registered tool)", () => {
  it("is admin-only, dry-runs by default, and its description names the redirect behaviour", async () => {
    const server = new CapturingMcpServer();
    registerUpdateSeriesTool(server as never, db, { role: "VENDOR" } as AuthContext);
    expect(server.handlers.has("update_series")).toBe(false);

    registerUpdateSeriesTool(server as never, db, {
      role: "ADMIN",
      userId: "admin-1",
    } as AuthContext);
    const handler = server.handlers.get("update_series");
    expect(handler).toBeDefined();
    const res = (await handler!({ series_id: "s1", slug: "new-fair", reason: "x" })) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(res.content[0].text)).toMatchObject({ applied: false, dry_run: true });
    expect(count("series_slug_history")).toBe(0);
    // The contract that stops callers reaching for SQL, asserted so it stays true.
    const d = server.descriptions.get("update_series")!;
    expect(d).toMatch(/series_slug_history/);
    expect(d).toMatch(/301/);
    expect(d).toMatch(/NAME change never moves the slug/);
    expect(d).toMatch(/DRY RUN/);
  });
});
