/**
 * OPE-1233 / OPE-1187 — rehearse drizzle/0344 against a seeded database, then
 * its rollback (docs/ope1233/rollback.sql), per docs/bulk-mutation-discipline.md.
 * Seeds are the pre-change rows captured from prod (docs/ope1233/*.json), so
 * this exercises the real files that ship, not a paraphrase of them.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTestDb } from "./setup-db.js";

const ROOT = resolve(__dirname, "../..");
const MIGRATION = readFileSync(
  resolve(ROOT, "drizzle/0344_ope1233_consolidate_split_series.sql"),
  "utf8"
);
const ROLLBACK = readFileSync(resolve(ROOT, "docs/ope1233/rollback.sql"), "utf8");
const DUMP: Array<Record<string, unknown>> = JSON.parse(
  readFileSync(resolve(ROOT, "docs/ope1233/pre-change-series-dump.json"), "utf8")
);
const EVMAP: Array<{ id: string; slug: string; series_id: string }> = JSON.parse(
  readFileSync(resolve(ROOT, "docs/ope1233/pre-change-event-series-map.json"), "utf8")
);
// The 12 keepers (bare slug) are not in the dump; their ids are in the migration.
const KEEPERS = [
  ...MIGRATION.matchAll(
    /SELECT lower\(hex\(randomblob\(16\)\)\), '([0-9a-f]+)', '([a-z0-9-]+)', '([a-z0-9-]+)', unixepoch\(\), 'ope-1233'/g
  ),
].map((m) => ({ id: m[1], dupSlug: m[2], slug: m[3] }));
const SURVIVOR = "the-big-e-eastern-states-exposition";

function seed() {
  const { raw } = createTestDb();
  raw.pragma("foreign_keys = ON");
  raw.prepare("INSERT INTO promoters (id, company_name, slug) VALUES ('p', 'P', 'p')").run();
  const insSeries = raw.prepare(
    "INSERT INTO event_series (id, canonical_slug, name, venue_id, created_at, updated_at) VALUES (?, ?, ?, NULL, 1, 1)"
  );
  for (const k of KEEPERS) insSeries.run(k.id, k.slug, k.slug);
  for (const s of DUMP) insSeries.run(s.id, s.canonical_slug, s.name);
  const insEvent = raw.prepare(
    "INSERT INTO events (id, name, slug, promoter_id, status, series_id) VALUES (?, ?, ?, 'p', 'APPROVED', ?)"
  );
  for (const e of EVMAP) insEvent.run(e.id, e.slug, e.slug, e.series_id);
  KEEPERS.forEach((k, i) => insEvent.run(`keep-ev-${i}`, k.slug, `${k.slug}-2026`, k.id));
  return raw;
}

const seriesOf = (raw: ReturnType<typeof seed>, eventId: string) =>
  (
    raw
      .prepare(
        "SELECT s.canonical_slug c FROM events e JOIN event_series s ON s.id = e.series_id WHERE e.id = ?"
      )
      .get(eventId) as { c: string } | undefined
  )?.c;

describe("drizzle/0344 — rehearsal on the captured pre-change rows", () => {
  it("found the 12 pairs the ticket names (landmark)", () => {
    expect(KEEPERS).toHaveLength(12);
    expect(DUMP).toHaveLength(14); // 12 dups + both Big E series
  });

  it("forward: every dup is retired, every child re-parented, every old slug has a redirect row", () => {
    const raw = seed();
    raw.exec(MIGRATION);
    for (const k of KEEPERS) {
      expect(
        raw.prepare("SELECT COUNT(*) n FROM event_series WHERE canonical_slug = ?").get(k.dupSlug)
      ).toEqual({ n: 0 });
      expect(
        raw.prepare("SELECT new_slug FROM series_slug_history WHERE old_slug = ?").get(k.dupSlug)
      ).toEqual({ new_slug: k.slug });
      expect(raw.prepare("SELECT COUNT(*) n FROM events WHERE series_id = ?").get(k.id)).toEqual({
        n: 2,
      });
    }
    // The Big E: one series at the survivor slug, holding both editions.
    expect(
      raw.prepare("SELECT id, name FROM event_series WHERE canonical_slug LIKE 'the-big-e%'").all()
    ).toEqual([
      { id: "415479ad80a361d18839c69ee5d998dd", name: "The Big E (Eastern States Exposition)" },
    ]);
    expect(seriesOf(raw, "beb08722-6476-43ea-9902-227099d6b23f")).toBe(SURVIVOR);
    expect(seriesOf(raw, "5881f7a15178a65ba7df986058c214fa")).toBe(SURVIVOR);
    for (const old of [
      "the-big-e-eastern-states-exposition-ma",
      "the-big-e-2026-eastern-states-exposition",
    ]) {
      expect(
        raw.prepare("SELECT new_slug FROM series_slug_history WHERE old_slug = ?").get(old)
      ).toEqual({ new_slug: SURVIVOR });
    }
    // Nothing orphaned.
    expect(raw.prepare("SELECT COUNT(*) n FROM events WHERE series_id IS NULL").get()).toEqual({
      n: 0,
    });
  });

  it("idempotent: running it twice changes nothing more", () => {
    const raw = seed();
    raw.exec(MIGRATION);
    const snap = JSON.stringify(raw.prepare("SELECT id, series_id FROM events ORDER BY id").all());
    const hist = raw.prepare("SELECT COUNT(*) n FROM series_slug_history").get();
    raw.exec(MIGRATION);
    expect(JSON.stringify(raw.prepare("SELECT id, series_id FROM events ORDER BY id").all())).toBe(
      snap
    );
    expect(raw.prepare("SELECT COUNT(*) n FROM series_slug_history").get()).toEqual(hist);
  });

  it("rollback restores the exact pre-change parents, slugs and children", () => {
    const raw = seed();
    const before = JSON.stringify(
      raw.prepare("SELECT id, series_id FROM events ORDER BY id").all()
    );
    raw.exec(MIGRATION);
    raw.exec(ROLLBACK);
    expect(JSON.stringify(raw.prepare("SELECT id, series_id FROM events ORDER BY id").all())).toBe(
      before
    );
    for (const s of DUMP) {
      expect(
        raw.prepare("SELECT canonical_slug c FROM event_series WHERE id = ?").get(s.id)
      ).toEqual({ c: s.canonical_slug });
    }
    expect(raw.prepare("SELECT COUNT(*) n FROM series_slug_history").get()).toEqual({ n: 0 });
  });

  it("is a no-op on an EMPTY database (CI applies every migration to a fresh D1)", () => {
    const { raw } = createTestDb();
    raw.pragma("foreign_keys = ON");
    expect(() => raw.exec(MIGRATION)).not.toThrow();
    expect(raw.prepare("SELECT COUNT(*) n FROM series_slug_history").get()).toEqual({ n: 0 });
  });
});
