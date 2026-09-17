/**
 * OPE-1058 — every writer of `events.categories` goes through one allow-list.
 *
 * The defect this replaces: `suggest_event` filtered against EVENT_CATEGORIES
 * while `update_event` took `z.array(z.string())` and stored whatever arrived.
 * The same value was therefore refused at one writer and accepted at the other
 * — the Alexander Hamfest was created with "Amateur Radio Convention" two
 * minutes after suggest_event dropped it — and ~100 distinct values accumulated
 * on live events against 34 in the canonical list, including "Craft Fsir".
 *
 * A behavioural test of any one writer passes in exactly that situation,
 * because each writer is self-consistent. What has to be asserted is a property
 * of the SET: no file writes this column without reading the shared rule.
 *
 * Keyed on the ACT (a write to `categories` on an events insert/update), not on
 * the fix. A guard keyed on the fix — "files that import the validator must
 * call it" — is blind to the case that matters, a new writer that imports
 * nothing (`[[feedback_a_guard_keyed_on_the_fix_is_blind_to_omitting_it]]`).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { EVENT_CATEGORIES } from "@takemetothefair/constants";

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".next" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/**
 * A WRITE is `categories:` inside a Drizzle `.values({…})` / `.set({…})`, or an
 * assignment into the object one of those is given (`updateData.categories =`).
 *
 * Everything else that shares the property name is not a write and is excluded
 * by construction rather than by a denylist of files: column definitions, select
 * projections, React form state, an extractor's return shape, and the blog
 * taxonomy (a different table).
 */
function categoryWrites(src: string): string[] {
  const writes: string[] = [];

  // 1. Assignment form: `updateData.categories = JSON.stringify(...)`, the
  //    shape a route uses when it builds an update object field by field.
  //    Only counted in a file that writes the events table at all — otherwise
  //    an HTTP payload built the same way (the blog tools do exactly this for
  //    blogPosts) reads as an events write.
  if (/\.(?:insert|update)\(\s*(?:schema\.)?(?:events|eventSeries)\s*\)/.test(src)) {
    for (const m of src.matchAll(/\w+\.categories\s*=\s*([^\n;]+)/g)) {
      writes.push(m[1].trim());
    }
  }

  // 2. Object-literal form. Walk from each `.values({` / `.set({` to its
  //    matching brace so a `categories:` further down the same object still
  //    counts — the writers put it 20+ lines in.
  for (const m of src.matchAll(/\.(?:values|set)\(\s*\{/g)) {
    let depth = 1;
    let i = m.index! + m[0].length;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
    }
    const block = src.slice(m.index!, i);
    for (const w of block.matchAll(/(?<![\w.])categories:\s*([^\n]+?),?\s*$/gm)) {
      const value = w[1].trim();
      if (/^\w+\.categories\b/.test(value)) continue; // projection inside a select
      writes.push(value);
    }
  }
  return writes;
}

function categoryWriterFiles(): { file: string; writes: string[] }[] {
  const out: { file: string; writes: string[] }[] = [];
  for (const dir of ["src", "packages", "mcp-server/src"]) {
    for (const f of walk(join(ROOT, dir))) {
      const rel = f.slice(ROOT.length + 1);
      if (rel.startsWith("src/test/")) continue; // fixtures, not writers
      const src = strip(readFileSync(f, "utf8"));
      // The blog tools write `blogPosts.categories`; scope to the events family.
      if (!/\b(events|eventsTable|eventSeries)\b/.test(src)) continue;
      const writes = categoryWrites(src);
      if (writes.length > 0) out.push({ file: rel, writes });
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/** The shared rule, in the forms a writer may legitimately use. */
const RULE = /partitionEventCategories\(|invalidEventCategories\(|eventCategoriesSchema\b/;
/** The schemas that carry the rule for routes that parse a request body. */
const SCHEMA = /eventCreateSchema|eventUpdateSchema|promoterEventCreateSchema/;

/** A write of literal values only, e.g. `JSON.stringify(["Fair", "Festival"])` or `"[]"`. */
function literalValues(write: string): string[] | null {
  if (/^(?:JSON\.stringify\(\s*\[\s*\]\s*\)|"\[\]"|\[\])$/.test(write)) return [];
  const m = write.match(/^JSON\.stringify\(\s*\[([^\]]*)\]\s*\)$/);
  if (!m) return null;
  const parts = m[1]
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (!parts.every((x) => /^"[^"]*"$/.test(x))) return null;
  return parts.map((x) => x.slice(1, -1));
}

describe("OPE-1058 — every events.categories writer reads the shared allow-list", () => {
  const writers = categoryWriterFiles();

  it("finds the known writers — a scan that matches nothing proves nothing", () => {
    expect(writers.map((w) => w.file)).toEqual(
      [
        "mcp-server/src/series/resolve-or-create-series.ts",
        "mcp-server/src/tools/vendor.ts",
        "src/app/api/admin/events/[id]/route.ts",
        "src/app/api/admin/events/route.ts",
        "src/app/api/admin/events/category-cleanup/route.ts",
        "src/app/api/admin/import-url/route.ts",
        "src/app/api/admin/import/route.ts",
        "src/app/api/promoter/events/draft/route.ts",
        "src/app/api/promoter/events/route.ts",
        "src/app/api/suggest-event/submit/route.ts",
        "src/lib/series/create-occurrence.ts",
      ].sort()
    );
  });

  it.each(categoryWriterFiles())("$file validates what it stores", ({ file, writes }) => {
    const src = strip(readFileSync(join(ROOT, file), "utf8"));
    // Three legitimate forms: the rule itself, a request body parsed through a
    // schema that carries the rule, or a write of literal values — which this
    // test then checks against EVENT_CATEGORIES itself, so a hardcoded typo is
    // caught here rather than in prod.
    const literalsOnly = writes.map(literalValues);
    if (literalsOnly.every((v) => v !== null)) {
      for (const values of literalsOnly as string[][]) {
        for (const value of values) {
          expect(EVENT_CATEGORIES as readonly string[], `${file} writes "${value}"`).toContain(
            value
          );
        }
      }
      return;
    }
    expect(RULE.test(src) || SCHEMA.test(src), `${file} writes ${writes.join(" | ")}`).toBe(true);
  });

  it("the schema the request-body routes parse through carries the rule", () => {
    expect(strip(readFileSync(join(ROOT, "packages/validation/src/index.ts"), "utf8"))).toMatch(
      /categories:\s*eventCategoriesSchema/
    );
  });
});
