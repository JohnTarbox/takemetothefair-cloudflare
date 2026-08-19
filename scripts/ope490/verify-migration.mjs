/**
 * OPE-490 — verification harness for drizzle/0212_ope490_null_venue_series_gap.sql.
 *
 * Touches no real database. Builds a throwaway in-memory SQLite mirroring the three
 * tables the migration writes to, with the REAL foreign-key actions — `events.series_id`
 * is ON DELETE SET NULL, `series_slug_history.series_id` is ON DELETE CASCADE — seeds it
 * from docs/ope490/pre-change-series-dump.json, and asserts the four properties
 * docs/bulk-mutation-discipline.md asks for:
 *
 *   A. NO-OP on an EMPTY database. CI applies every migration to a fresh D1, and an
 *      unguarded FK-bearing INSERT aborts the WHOLE run — the exact failure that hit
 *      OPE-473 before it shipped.
 *   B. Against the real pre-change rows, the intended end state, orphaning nothing.
 *   C. Idempotent. Worth asserting rather than assuming: the redirect INSERT keys on
 *      `randomblob(16)` and there is no unique constraint on (old_slug, new_slug), so
 *      `INSERT OR IGNORE` alone would NOT be idempotent — hence the NOT EXISTS guard.
 *   D. docs/ope490/rollback.sql restores the pre-change state byte-for-byte, and is
 *      itself idempotent.
 *
 * Run: node scripts/ope490/verify-migration.mjs   (exit 0 = all green)
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const MIG = read("drizzle/0212_ope490_null_venue_series_gap.sql");
const RB = read("docs/ope490/rollback.sql");
const DUMP = JSON.parse(read("docs/ope490/pre-change-series-dump.json"));

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE venues (id TEXT PRIMARY KEY);
CREATE TABLE promoters (id TEXT PRIMARY KEY);
CREATE TABLE event_series (
  id TEXT PRIMARY KEY,
  canonical_slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  venue_id TEXT REFERENCES venues(id) ON DELETE SET NULL,
  promoter_id TEXT REFERENCES promoters(id) ON DELETE SET NULL,
  recurrence_rule TEXT,
  description TEXT,
  image_url TEXT,
  categories TEXT,
  tags TEXT,
  primary_audience TEXT,
  public_access TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  venue_id TEXT REFERENCES venues(id) ON DELETE SET NULL,
  series_id TEXT REFERENCES event_series(id) ON DELETE SET NULL,
  start_date INTEGER,
  end_date INTEGER,
  merged_into TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE series_slug_history (
  id TEXT PRIMARY KEY,
  series_id TEXT NOT NULL REFERENCES event_series(id) ON DELETE CASCADE,
  old_slug TEXT NOT NULL,
  new_slug TEXT NOT NULL,
  changed_at INTEGER NOT NULL,
  changed_by TEXT
);
`;

const fresh = () => { const db = new Database(":memory:"); db.exec(SCHEMA); return db; };
const snap = (db) => JSON.stringify({
  series: db.prepare("SELECT * FROM event_series ORDER BY id").all(),
  events: db.prepare("SELECT id, series_id FROM events ORDER BY id").all(),
  hist:   db.prepare("SELECT series_id, old_slug, new_slug, changed_by FROM series_slug_history ORDER BY old_slug").all(),
}, null, 1);

function seed(db) {
  db.prepare("INSERT INTO venues (id) VALUES (?)").run("a00e9108-9a86-4a64-acee-7dfe13f81f57");
  for (const p of ["system-community-suggestions", "b4401fb2-8bb7-4764-80be-5625434f8cdc"])
    db.prepare("INSERT INTO promoters (id) VALUES (?)").run(p);
  const ins = db.prepare(`INSERT INTO event_series
    (id,canonical_slug,name,venue_id,promoter_id,recurrence_rule,description,image_url,categories,tags,primary_audience,public_access,created_at,updated_at)
    VALUES (@id,@canonical_slug,@name,@venue_id,@promoter_id,@recurrence_rule,@description,@image_url,@categories,@tags,@primary_audience,@public_access,@created_at,@updated_at)`);
  for (const r of DUMP) { const { _role, ...row } = r; ins.run(row); }
  const ev = db.prepare("INSERT INTO events (id,slug,name,status,venue_id,series_id,start_date,end_date,merged_into,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
  ev.run("e62cc863-ce9b-4004-8039-04e208b0ef4e","maine-pottery-tour-2026-1","Maine Pottery Tour 2026","APPROVED",null,"3108923d4c7d956a3aa4c5f2e82f873d",1777680000,1777766400,null,1784127161);
  ev.run("89c4b711-887d-4e72-ad9a-b00e7d9b92b7","maine-pottery-tour-2026","Maine Pottery Tour 2026","REJECTED",null,"0e1e7676767e411db8f13de2c373f53d",1777680000,1777766400,null,1784127161);
  ev.run("8c4d6e89-06d6-4bbc-b44d-d00c93933591","fiber-festival-of-new-england-2026","Fiber Festival of New England 2026","APPROVED","a00e9108-9a86-4a64-acee-7dfe13f81f57","552356339b94afb0ba442aa702e68132",1794182400,null,null,1784127161);
  ev.run("b4248709-c30b-48a1-b98c-f2fc2638af3c","fiber-festival-of-new-england-2026-1","Fiber Festival of New England 2026","REJECTED",null,"6884cba94c324736cecaedd4a3f9d958",1794182400,null,null,1784127161);
}

let fail = 0;
const ok = (label, cond, extra) => { console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}`); if (!cond) { fail++; if (extra) console.log("        " + extra); } };

// ── A. empty database (the CI failure mode that bit OPE-473) ───────────────
console.log("\nA. migration against an EMPTY database (FKs ON)");
{
  const db = fresh();
  let threw = null;
  try { db.exec(MIG); } catch (e) { threw = e.message; }
  ok("does not throw", threw === null, threw);
  ok("writes nothing (series)",  db.prepare("SELECT COUNT(*) c FROM event_series").get().c === 0);
  ok("writes nothing (history)", db.prepare("SELECT COUNT(*) c FROM series_slug_history").get().c === 0);
  db.close();
}

// ── B. against the real pre-change rows ────────────────────────────────────
console.log("\nB. migration against the real prod rows");
const db = fresh(); seed(db);
const before = snap(db);
db.exec(MIG);
{
  const s = (id) => db.prepare("SELECT * FROM event_series WHERE id=?").get(id);
  const e = (id) => db.prepare("SELECT * FROM events WHERE id=?").get(id);
  ok("dupe series 3108923d deleted", !s("3108923d4c7d956a3aa4c5f2e82f873d"));
  ok("dupe series 6884cba9 deleted", !s("6884cba94c324736cecaedd4a3f9d958"));
  ok("keeper 0e1e7676 survives",     !!s("0e1e7676767e411db8f13de2c373f53d"));
  ok("keeper 552356 survives",       !!s("552356339b94afb0ba442aa702e68132"));
  ok("APPROVED pottery event re-parented to keeper",
     e("e62cc863-ce9b-4004-8039-04e208b0ef4e").series_id === "0e1e7676767e411db8f13de2c373f53d");
  ok("REJECTED fiber event re-parented to keeper",
     e("b4248709-c30b-48a1-b98c-f2fc2638af3c").series_id === "552356339b94afb0ba442aa702e68132");
  ok("no event orphaned (series_id NULL)",
     db.prepare("SELECT COUNT(*) c FROM events WHERE series_id IS NULL").get().c === 0);
  const k = s("0e1e7676767e411db8f13de2c373f53d");
  ok("keeper description no longer the DUPLICATE marker", !k.description.includes("[DUPLICATE"));
  ok("keeper description is the live edition's copy", k.description.startsWith("Annual self-guided tour"));
  ok("keeper image now on our CDN", k.image_url.startsWith("https://cdn.meetmeatthefair.com/"));
  ok("keeper tags carried", k.tags === '["pottery","artisan","statewide","studio-tour","spring"]');
  ok("keeper categories carried", k.categories === '["Festival"]');
  const f = s("552356339b94afb0ba442aa702e68132");
  ok("fiber keeper content UNTOUCHED", f.description.includes("Sheep & Wool Growers") && f.updated_at === 1784127161);
  ok("2 redirect rows written", db.prepare("SELECT COUNT(*) c FROM series_slug_history").get().c === 2);
  ok("redirects point at the keepers",
     db.prepare("SELECT COUNT(*) c FROM series_slug_history WHERE (old_slug='maine-pottery-tour-2026-1' AND new_slug='maine-pottery-tour') OR (old_slug='fiber-festival-of-new-england-2026-1' AND new_slug='fiber-festival-of-new-england')").get().c === 2);
}

// ── C. idempotency ─────────────────────────────────────────────────────────
console.log("\nC. re-running the migration changes nothing");
{
  const after1 = snap(db);
  db.exec(MIG);
  const after2 = snap(db);
  ok("second run is a no-op", after1 === after2);
  ok("still exactly 2 redirect rows (no randomblob duplicate)",
     db.prepare("SELECT COUNT(*) c FROM series_slug_history").get().c === 2);
}

// ── D. rollback round-trip ─────────────────────────────────────────────────
console.log("\nD. rollback restores the pre-change state byte-for-byte");
{
  db.exec(RB);
  const restored = snap(db);
  ok("state identical to pre-change snapshot", restored === before);
  if (restored !== before) {
    const a = before.split("\n"), b = restored.split("\n");
    for (let i = 0; i < Math.max(a.length, b.length); i++)
      if (a[i] !== b[i]) console.log(`        line ${i}:\n          before:   ${a[i]}\n          restored: ${b[i]}`);
  }
  db.exec(RB);
  ok("rollback is itself idempotent", snap(db) === before);
}
db.close();

console.log(fail === 0 ? "\n✅ all checks passed\n" : `\n❌ ${fail} check(s) failed\n`);
process.exit(fail === 0 ? 0 : 1);
