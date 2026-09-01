/**
 * The placeholder cohort, and the guard that stops it being counted as people.
 *
 * Prod, 2026-08-31: 7,878 users, 7,577 of them `pending+…@` ingestion
 * placeholders — 96.2%. A raw count is inflated ~26x, and that inflation has
 * twice argued for a bulk mutation that would have been wrong (OPE-697's "717
 * promoters need a backfill", true population zero; OPE-703's "717 unverified
 * accounts", all sessionless).
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import * as schema from "@takemetothefair/db-schema";
import { realUserWhere } from "@takemetothefair/db-schema";
import { users } from "@/lib/db/schema";

const SCHEMA_SQL = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT,
    origin TEXT
  );
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;

function seed(id: string, email: string | null, origin: string | null) {
  raw.prepare(`INSERT INTO users (id, email, origin) VALUES (?,?,?)`).run(id, email, origin);
}
const realIds = async () =>
  (await db.select({ id: users.id }).from(users).where(realUserWhere())).map(
    (r: { id: string }) => r.id
  );

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

describe("realUserWhere", () => {
  it("excludes a placeholder identified by origin", async () => {
    seed("p", "pending+some-fair@meetmeatthefair.com", "ingestion");
    seed("r", "someone@example.com", "registration");
    expect(await realIds()).toEqual(["r"]);
  });

  it("excludes a placeholder whose origin was never stamped", async () => {
    // The data-health report carries a `misfiled_placeholders` probe because a
    // creation path CAN stop stamping origin. On that day the email shape is
    // what keeps the count honest — which is why both are checked.
    seed("p", "pending+some-fair@meetmeatthefair.com", "registration");
    expect(await realIds()).toEqual([]);
  });

  it("excludes a placeholder whose email looks normal but origin says ingestion", async () => {
    seed("p", "coordinator@somefair.org", "ingestion");
    expect(await realIds()).toEqual([]);
  });

  it("KEEPS a legacy row whose origin is NULL", async () => {
    // The load-bearing case. `NULL <> 'ingestion'` is NULL in SQL, so an
    // un-COALESCEd filter would silently drop every legacy row — producing a
    // smaller, tidier, wrong number. Same trap as isNonResearchCategory.
    seed("legacy", "realperson@example.com", null);
    expect(await realIds()).toEqual(["legacy"]);
  });

  it("KEEPS a row with a NULL email", async () => {
    seed("odd", null, "registration");
    expect(await realIds()).toEqual(["odd"]);
  });

  it("reproduces the prod ratio shape", async () => {
    for (let i = 0; i < 20; i++)
      seed(`p${i}`, `pending+fair-${i}@meetmeatthefair.com`, "ingestion");
    seed("real", "a@b.com", "registration");
    const ids = await realIds();
    expect(ids).toEqual(["real"]);
    // The point of the helper, stated as an assertion: the raw count is 21x the
    // real one.
    const total = (raw.prepare(`SELECT COUNT(*) n FROM users`).get() as { n: number }).n;
    expect(total).toBe(21);
  });
});

/**
 * The anti-drift guard. The expression was inlined in at least four places
 * before this helper existed, each spelled slightly differently — which is how
 * one of them ends up subtly wrong and nobody notices.
 */
describe("nobody re-inlines the placeholder predicate", () => {
  const ROOT = join(__dirname, "..", "..", "..");
  const ROOTS = ["src", "mcp-server/src", "packages"];
  const ALLOWED = new Set([
    // The helper itself.
    "packages/db-schema/src/real-users.ts",
    // OPE-292's probe deliberately looks for the DISAGREEMENT between the two
    // signals, so it must name both directly — using the helper would hide the
    // very mismatch it exists to detect.
    "mcp-server/src/tools/admin-data-health.ts",
    // Same reason: this one reports whether the email signal and the origin
    // signal AGREE per row. Routing it through the helper would collapse the two
    // into one answer and destroy the comparison.
    "mcp-server/src/tools/admin-vendor-read.ts",
  ]);

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
    }
    return out;
  }

  // A LIKE/startsWith on the placeholder prefix, or a comparison against the
  // origin literal, in a query context.
  // Strip block and line comments first: the prefix is legitimately DESCRIBED in
  // prose (the db-schema docblock names the convention), and flagging a comment
  // teaches people to ignore the guard.
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const INLINE = /(pending\+%|["'`]ingestion["'`]\s*\))/;

  const offenders = ROOTS.flatMap((r) => walk(join(ROOT, r)))
    .map((f) => ({ rel: relative(ROOT, f).replace(/\\/g, "/"), src: readFileSync(f, "utf8") }))
    .filter((f) => INLINE.test(stripComments(f.src)))
    .filter((f) => !ALLOWED.has(f.rel))
    .map((f) => f.rel);

  it("finds no re-inlined placeholder predicates outside the helper", () => {
    expect(
      offenders,
      `Use realUserWhere() / isPlaceholderUser() from @takemetothefair/db-schema ` +
        `instead of spelling the placeholder test inline. If a file genuinely needs ` +
        `the raw signals (like the misfiled-placeholder probe), add it to ALLOWED ` +
        `with a reason.`
    ).toEqual([]);
  });
});
