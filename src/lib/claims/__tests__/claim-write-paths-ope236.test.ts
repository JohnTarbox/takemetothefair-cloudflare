/**
 * OPE-236 §4 — every path that claims a PRE-EXISTING listing records it.
 *
 * This is a structural guard, and it exists because the failure it prevents has
 * already happened three times in the same codebase: `admin_approve_vendor_claim`,
 * `/api/vendor/claim/direct` and `/api/vendor/claim/confirm` each stamped
 * `vendors.claimed = true` and each independently forgot `entity_claims`. Every
 * one of them was correct about the flag and invisible to `/admin/claims`.
 *
 * A behavioural test per handler would pin the three we know about. It would not
 * notice a FOURTH path added next month, which is the actual recurrence risk —
 * "a fix wired into one of two parallel paths" is this repo's most-repeated
 * defect. So the test enumerates the writers from source and requires each to be
 * either an explicitly-reasoned exemption or a recorder.
 *
 * The allowlist is the point of the test, not a way around it: adding a file to
 * it is a deliberate, reviewable claim that the path authors a listing rather
 * than claiming one.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "..", "..", "..");
const SEARCH_ROOTS = ["src", "mcp-server/src"];

/**
 * Paths that set `claimed: true` and correctly do NOT write `entity_claims`.
 * Each needs a reason, and the reason must be about the DATA, not convenience.
 */
const EXEMPT: Record<string, string> = {
  "src/lib/claims/resolve-claim-at-signup.ts":
    "Authoring is not claiming. This branch covers a registrant creating their own listing at signup — 70 of the 73 claimed rows. It DOES insert entity_claims on its genuine claim-over-existing branches; the exemption is only that not every write here mints one.",
  "src/lib/claims/admin-review.ts":
    "Approves an entity_claims row that already exists; minting a second would double-count one claim.",
  "mcp-server/src/tools/admin-claim-review.ts":
    "The MCP approve_claim/reject_claim pair — same reasoning as admin-review.ts: it settles a row that is already there.",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** `.set({ ... claimed: true ... })` — the ownership stamp, not a read. */
const CLAIMS_OWNERSHIP = /\.set\(\{[^}]*\bclaimed:\s*true/s;

describe("OPE-236 — claim write paths record entity_claims", () => {
  const writers = SEARCH_ROOTS.flatMap((r) => walk(join(ROOT, r)))
    .map((f) => ({ rel: relative(ROOT, f).replace(/\\/g, "/"), src: readFileSync(f, "utf8") }))
    .filter((f) => CLAIMS_OWNERSHIP.test(f.src));

  it("finds the known ownership-stamping paths (guards against a vacuous pass)", () => {
    // Without this the suite would go green if the regex silently stopped
    // matching anything — a structural test that finds no inputs proves nothing.
    expect(writers.length).toBeGreaterThanOrEqual(8);
    const rels = writers.map((w) => w.rel);
    expect(rels).toContain("mcp-server/src/tools/admin-claim-approval.ts");
    expect(rels).toContain("src/app/api/vendor/claim/direct/route.ts");
    expect(rels).toContain("src/app/api/vendor/claim/confirm/route.ts");
  });

  it.each([
    "mcp-server/src/tools/admin-claim-approval.ts",
    "src/app/api/vendor/claim/direct/route.ts",
    "src/app/api/vendor/claim/confirm/route.ts",
    // Not in OPE-236 §4's list, which was scoped to the vendor investigation.
    // This guard found them, and they are the identical defect one and two
    // entities over — /admin/claims reads PROMOTER from the same table, and
    // OPE-318 added PERFORMER to the enum so performer claims could be reviewed.
    "mcp-server/src/tools/promoter-claim-approval.ts",
    "mcp-server/src/tools/performer-claim-approval.ts",
    "src/app/api/performer/claim/direct/route.ts",
  ])("%s inserts the canonical claim row", (rel) => {
    const found = writers.find((w) => w.rel === rel);
    expect(found, `${rel} no longer stamps claimed:true`).toBeDefined();
    expect(found!.src).toContain("insert(entityClaims)");
    // Via the shared builder, not a hand-rolled object — a second hand-rolled
    // insert is how the two trees drift back apart.
    expect(found!.src).toContain("buildSettledEntityClaim");
    expect(found!.src).toContain("shouldRecordEntityClaim");
  });

  it("every ownership-stamping file either records a claim or is a reasoned exemption", () => {
    const offenders = writers
      .filter((w) => !(w.rel in EXEMPT))
      .filter((w) => !w.src.includes("insert(entityClaims)"))
      .map((w) => w.rel);

    expect(
      offenders,
      `These set vendors/promoters.claimed = true without writing entity_claims. ` +
        `Either record the claim (buildSettledEntityClaim + shouldRecordEntityClaim) or add ` +
        `the file to EXEMPT with a reason about the data. See OPE-236 §4.`
    ).toEqual([]);
  });
});
