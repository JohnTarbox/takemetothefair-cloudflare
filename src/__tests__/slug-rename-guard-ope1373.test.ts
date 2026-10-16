/**
 * OPE-1373 — every write that changes a promoter / venue / vendor slug must
 * also write the `*_slug_history` row the middleware 301s from.
 *
 * The defect: OPE-495/518 wired history into the MCP `update_promoter` /
 * `update_venue`, but three APP paths renamed the same rows with no history
 * row at all (admin promoter PATCH, admin venue PATCH, Google backfill), so an
 * admin rename 404'd the old URL. Each surface had its own copy of the
 * collision loop and its own — or no — history INSERT. That is the "fix wired
 * into one of two parallel paths" shape, and the gap is an ABSENCE: no runtime
 * test fails when a redirect is not written.
 *
 * So this guard is source-level, over the app AND the MCP worker:
 *
 *  1. Every `<payload>.slug = …` assignment on an update payload must take its
 *     value from `planSlugRename()` (`<plan>.nextSlug`), which builds the
 *     history INSERT for that exact slug. The few non-target-entity paths
 *     (events, blog posts — they own their own history tables) are allow-listed
 *     BY COUNT, so a new raw assignment in one of those files still fails.
 *  2. Every `.update(promoters|venues|vendors).set({ … slug … })` (the merge
 *     tombstone renames) must sit in a file that INSERTs into that entity's
 *     history table.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const SCAN_DIRS = ["src/app", "src/lib", "mcp-server/src", "packages"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__") continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const FILES = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d))).map((f) => ({
  rel: path.relative(ROOT, f).split(path.sep).join("/"),
  src: readFileSync(f, "utf8"),
}));

/** Update-payload variable names. Audit snapshots (previousValues/newValues) are not writes. */
const PAYLOAD_ASSIGN =
  /\b(updateData|updates|venueUpdates|vendorUpdates|promoterUpdates)\.slug\s*=(?!=)\s*([^;]+);/g;
const FROM_HELPER = /^\w+\.nextSlug$/;

/**
 * Raw slug assignments that are NOT promoter/venue/vendor renames, by count.
 * Each of these entities writes its own history table on its own path.
 */
const ALLOWED_RAW: Record<string, { count: number; why: string }> = {
  "src/app/api/admin/events/[id]/route.ts": {
    count: 1,
    why: "event rename — writes event_slug_history itself",
  },
  "src/app/api/blog-posts/[slug]/route.ts": {
    count: 1,
    why: "blog rename — writes blog_slug_history itself",
  },
  "mcp-server/src/tools/admin.ts": {
    count: 1,
    why: "update_event rename — writes event_slug_history itself",
  },
};

describe("OPE-1373 — promoter/venue/vendor slug writes go through planSlugRename", () => {
  it("the scan actually sees the rename paths (non-vacuous)", () => {
    const rels = FILES.map((f) => f.rel);
    for (const must of [
      "src/app/api/admin/promoters/[id]/route.ts",
      "src/app/api/admin/venues/[id]/route.ts",
      "src/app/api/admin/venues/google-backfill/route.ts",
      "src/app/api/admin/vendors/[id]/route.ts",
      "src/app/api/vendor/profile/route.ts",
      "mcp-server/src/tools/admin.ts",
      "packages/db-schema/src/slug-rename.ts",
    ]) {
      expect(rels).toContain(must);
    }
    const total = FILES.reduce((n, f) => n + [...f.src.matchAll(PAYLOAD_ASSIGN)].length, 0);
    expect(total).toBeGreaterThanOrEqual(10);
  });

  it("every update-payload `.slug =` takes its value from a planSlugRename() plan", () => {
    const offenders: string[] = [];
    for (const { rel, src } of FILES) {
      const raw = [...src.matchAll(PAYLOAD_ASSIGN)].filter((m) => !FROM_HELPER.test(m[2].trim()));
      const allowed = ALLOWED_RAW[rel]?.count ?? 0;
      if (raw.length !== allowed) {
        offenders.push(
          `${rel}: ${raw.length} raw slug assignment(s), ${allowed} allowed — ${raw
            .map((m) => m[0])
            .join(" | ")}`
        );
      }
      if (raw.length === 0 && /\.nextSlug\b/.test(src) && !/planSlugRename\(/.test(src)) {
        offenders.push(`${rel}: uses .nextSlug without calling planSlugRename()`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every file that uses a plan also commits its historyInsert", () => {
    const offenders = FILES.filter(
      ({ rel, src }) =>
        rel !== "packages/db-schema/src/slug-rename.ts" &&
        /planSlugRename\(/.test(src) &&
        (src.match(/planSlugRename\(/g) ?? []).length >
          (src.match(/\.historyInsert\b/g) ?? []).length
    ).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("every `.update(<entity>).set({ …slug… })` sits beside an INSERT into that entity's history", () => {
    const TABLE = { promoters: "promoter", venues: "venue", vendors: "vendor" } as const;
    const offenders: string[] = [];
    for (const { rel, src } of FILES) {
      for (const m of src.matchAll(
        /\.update\((?:schema\.)?(promoters|venues|vendors)\)\s*\.set\((\{[^;]*?\})\)/g
      )) {
        if (!/\bslug\b/.test(m[2])) continue;
        const entity = TABLE[m[1] as keyof typeof TABLE];
        if (
          !src.includes(`insert(${entity}SlugHistory)`) &&
          !src.includes(`insert(schema.${entity}SlugHistory)`)
        ) {
          offenders.push(
            `${rel}: .update(${m[1]}).set({ slug }) with no ${entity}SlugHistory insert`
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
