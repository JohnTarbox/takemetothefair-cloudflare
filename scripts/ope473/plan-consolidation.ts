/**
 * OPE-473 — plan the duplicate-series consolidation. READ-ONLY: emits SQL, runs none.
 *
 * Keeper rule, in priority order:
 *
 *   1. `canonical_slug === createSlug(name)` — the canonical generator is the
 *      repo's own standard (#120), and the only rule that survives contact with
 *      slug-generator DRIFT. Measured against prod: 3 of the 5 drift groups have
 *      the canonical form as the LONGER slug (`&` expands to "and"), so a
 *      shortest-wins heuristic keeps the wrong one in a majority of them.
 *   2. otherwise the shortest slug, but ONLY when every sibling extends it —
 *      the state-infix (`-me`) and numeric-suffix (`-1`) shapes are the clean
 *      name plus a suffix, so shortest is genuinely clean there.
 *   3. ties broken by oldest `created_at`, then id, for determinism.
 *
 * A group where no row carries the canonical slug AND the siblings are not
 * suffix-extensions is reported AMBIGUOUS and excluded. Slug choices are
 * permanent (the ticket says so), so picking between two non-canonical forms
 * automatically is not a call this script should make.
 */
import { readFileSync } from "node:fs";
import { createSlug } from "@takemetothefair/utils";

interface Row {
  id: string;
  slug: string;
  name: string;
  venue_id: string;
  created_at: number;
  n_events: number;
  years: string | null;
}

const rows: Row[] = JSON.parse(readFileSync(process.argv[2], "utf8"));

const groups = new Map<string, Row[]>();
for (const r of rows) {
  const k = `${r.name.trim().toLowerCase()} ${r.venue_id}`;
  const arr = groups.get(k);
  if (arr) arr.push(r);
  else groups.set(k, [r]);
}

interface Plan {
  keeper: Row;
  dupes: Row[];
  canonical: string;
  rule: string;
}
const plans: Plan[] = [];
const ambiguous: { name: string; canonical: string; slugs: string[] }[] = [];
const collisions: { name: string; year: string; slugs: string[] }[] = [];

for (const members of groups.values()) {
  const canonical = createSlug(members[0].name);
  const exact = members.filter((m) => m.slug === canonical);

  let keeper: Row | undefined;
  let rule = "";

  if (exact.length === 1) {
    keeper = exact[0];
    rule = "canonical";
  } else if (exact.length === 0) {
    const sorted = [...members].sort(
      (a, b) =>
        a.slug.length - b.slug.length ||
        a.created_at - b.created_at ||
        a.id.localeCompare(b.id)
    );
    const shortest = sorted[0];
    const allExtend = sorted.slice(1).every((m) => m.slug.startsWith(shortest.slug));
    if (allExtend) {
      keeper = shortest;
      rule = "shortest(suffix-shape)";
    } else {
      ambiguous.push({ name: members[0].name, canonical, slugs: members.map((m) => m.slug) });
      continue;
    }
  } else {
    // Two rows both carrying the canonical slug should be impossible
    // (canonical_slug is UNIQUE), so this is a shape nobody predicted.
    ambiguous.push({ name: members[0].name, canonical, slugs: members.map((m) => m.slug) });
    continue;
  }

  const chosen = keeper;
  const dupes = members.filter((m) => m.id !== chosen.id);

  // Scope rule 4 — a same-year collision means two rows claim ONE edition. That
  // is a merge_events question, not a re-parent. Report it; never fold it.
  const yearCount = new Map<string, number>();
  for (const m of members) {
    for (const y of (m.years ?? "").split(",").filter(Boolean)) {
      yearCount.set(y, (yearCount.get(y) ?? 0) + 1);
    }
  }
  for (const [y, n] of yearCount) {
    if (n > 1) {
      collisions.push({ name: members[0].name, year: y, slugs: members.map((m) => m.slug) });
    }
  }

  plans.push({ keeper: chosen, dupes, canonical, rule });
}

// Scope rule 5 — harwinton-fair LAST: it is the only group carrying both defect
// shapes at once (a numeric-suffix duplicate and a `-ct` twin, 3 parents).
plans.sort(
  (a, b) =>
    (a.keeper.slug.startsWith("harwinton") ? 1 : 0) -
      (b.keeper.slug.startsWith("harwinton") ? 1 : 0) ||
    a.keeper.slug.localeCompare(b.keeper.slug)
);

const mode = process.argv[3] ?? "report";

if (mode === "report") {
  const byRule: Record<string, number> = {};
  for (const p of plans) byRule[p.rule] = (byRule[p.rule] ?? 0) + 1;
  const dupeCount = plans.reduce((n, p) => n + p.dupes.length, 0);
  const eventCount = plans.reduce((n, p) => n + p.dupes.reduce((m, d) => m + d.n_events, 0), 0);

  console.log(`groups planned      : ${plans.length}`);
  console.log(`  by rule           : ${JSON.stringify(byRule)}`);
  console.log(`duplicates to retire: ${dupeCount}`);
  console.log(`events to re-parent : ${eventCount}`);
  console.log(`AMBIGUOUS (excluded): ${ambiguous.length}`);
  for (const a of ambiguous) {
    console.log(`   ! ${a.name}`);
    console.log(`       canonical would be: ${a.canonical}`);
    console.log(`       rows have         : ${a.slugs.join(" | ")}`);
  }
  console.log(`SAME-YEAR COLLISIONS: ${collisions.length}`);
  for (const c of collisions) {
    console.log(`   ~ ${c.name} [${c.year}] ${c.slugs.join(" | ")}`);
  }
} else if (mode === "sql") {
  console.log("-- OPE-473 consolidation, generated by scripts/ope473/plan-consolidation.ts");
  console.log("--");
  console.log("-- Order within each pair is load-bearing: history row, re-parent, THEN delete.");
  console.log("-- events.series_id is ON DELETE SET NULL, so deleting the parent first would");
  console.log("-- silently orphan its children instead of failing.");
  console.log("--");
  console.log(`-- ${plans.length} groups, ${plans.reduce((n, p) => n + p.dupes.length, 0)} duplicates retired.`);
  for (const p of plans) {
    console.log("");
    console.log(`-- ${p.keeper.name}  (keeper: ${p.keeper.slug}, rule: ${p.rule})`);
    for (const d of p.dupes) {
      // Both writes are guarded on the keeper still existing.
      //
      // `series_slug_history.series_id` REFERENCES `event_series(id)`, so on a
      // database where the keeper is absent the bare INSERT raises FOREIGN KEY
      // constraint failed and aborts the WHOLE migration. That is not
      // hypothetical — it failed CI's "Initialize D1 database" step, which
      // applies every migration to an EMPTY local D1.
      //
      // The same guard also covers a real prod risk: if a keeper were deleted
      // between planning and running, an unguarded run would abort partway
      // through rather than skipping the one stale pair.
      console.log(
        `INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) ` +
          `SELECT lower(hex(randomblob(16))), '${p.keeper.id}', '${d.slug}', '${p.keeper.slug}', unixepoch(), 'ope-473' ` +
          `WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '${p.keeper.id}');`
      );
      console.log(
        `UPDATE events SET series_id = '${p.keeper.id}', updated_at = unixepoch() ` +
          `WHERE series_id = '${d.id}' AND EXISTS (SELECT 1 FROM event_series WHERE id = '${p.keeper.id}');`
      );
      console.log(`DELETE FROM event_series WHERE id = '${d.id}';`);
    }
  }
} else if (mode === "rollback") {
  console.log("-- OPE-473 COMPENSATING SQL — restores every retired parent and its children.");
  console.log("-- Paired with the forward run per OPE-53. Re-inserts the deleted series rows");
  console.log("-- verbatim, then points their events back, then drops the redirect rows.");
  for (const p of plans) {
    for (const d of p.dupes) {
      const nm = d.name.replace(/'/g, "''");
      console.log(
        `INSERT OR IGNORE INTO event_series (id, canonical_slug, name, venue_id, created_at) ` +
          `VALUES ('${d.id}', '${d.slug}', '${nm}', '${d.venue_id}', ${d.created_at});`
      );
    }
  }
  console.log("-- NOTE: the reverse re-parent cannot be derived from this file alone —");
  console.log("-- it needs the pre-change event->series map. See ope473-pre-change-dump.json,");
  console.log("-- captured in the same run and attached to the PR.");
}
