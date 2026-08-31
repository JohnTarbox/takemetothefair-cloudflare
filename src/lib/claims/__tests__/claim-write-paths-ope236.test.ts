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
    // OPE-697 — the promoter sibling. It transferred user_id and stamped
    // NEITHER the flag nor a claim row, so the guard above could not see it:
    // that check enumerates files matching `.set({ ... claimed: true ... })`,
    // and a path which forgets the stamp too is invisible to it. Once it
    // stamps, it is in scope here; the second describe block below closes the
    // hole that let it hide.
    "src/app/api/promoter/claim/direct/route.ts",
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

/**
 * OPE-697 — the blind spot in the guard above.
 *
 * That guard finds ownership-stampers and asks whether they record the claim.
 * It is therefore blind to a path that forgets BOTH: `/api/promoter/claim/direct`
 * transferred `user_id` and set neither `claimed` nor `entity_claims`, so it
 * never matched the regex and never appeared as an offender. The guard was
 * built the day before this was found and could not have caught it.
 *
 * This closes it from the other side. Inside a claim path, an update to an
 * ENTITY table is an ownership transfer, and an ownership transfer that does
 * not stamp `claimed` produces exactly the invisible row OPE-236 exists to
 * prevent — invisible to `/admin/claims`, to `list_claims`, and to the public
 * "Claimed" badge.
 *
 * Keyed on the TABLE rather than on the object keys, deliberately. The obvious
 * alternative — "a `.set({ ... userId ... })`" — also matches four
 * `entity_claims` status writes whose value happens to be named `userId`
 * (`decidedBy: userId`). Those are claim ADJUDICATIONS, not ownership, and a
 * rule that flagged them would be noise the next reader learns to ignore.
 */
describe("OPE-697 — a claim path may not transfer ownership without stamping `claimed`", () => {
  const ENTITY_UPDATE = /\.update\(\s*(vendors|promoters|performers)\s*\)\s*\.set\(\{([^}]*)\}/gs;

  const claimFiles = SEARCH_ROOTS.flatMap((r) => walk(join(ROOT, r)))
    .map((f) => ({ rel: relative(ROOT, f).replace(/\\/g, "/"), src: readFileSync(f, "utf8") }))
    .filter((f) => f.rel.toLowerCase().includes("claim"));

  const transfers = claimFiles.flatMap(({ rel, src }) =>
    Array.from(src.matchAll(ENTITY_UPDATE)).map((m) => ({
      rel,
      table: m[1],
      body: m[2],
      line: src.slice(0, m.index ?? 0).split("\n").length,
    }))
  );

  it("finds the ownership transfers (guards against a vacuous pass)", () => {
    // If the drizzle call shape changes and this stops matching, the block
    // below would pass by finding nothing — the failure mode this repo has
    // shipped before.
    expect(transfers.length).toBeGreaterThanOrEqual(10);
    expect(transfers.map((t) => t.rel)).toContain("src/app/api/promoter/claim/direct/route.ts");
  });

  it("every entity update inside a claim path stamps claimed:true", () => {
    const offenders = transfers
      .filter((t) => !/\bclaimed:\s*true/.test(t.body))
      .map((t) => `${t.rel}:${t.line} (${t.table})`);

    expect(
      offenders,
      `These transfer ownership inside a claim path without stamping ` +
        `claimed/claimedAt/claimedBy. The row then reads as unclaimed to every ` +
        `surface that keys on the flag. See OPE-697.`
    ).toEqual([]);
  });

  it("does not flag entity_claims adjudications, which are not ownership", () => {
    // Pins the scoping decision above. If someone "simplifies" the regex to
    // match on `userId`, this fails and explains why it was table-scoped.
    const adjudications = claimFiles.filter(({ src }) =>
      /\.update\(\s*entityClaims\s*\)/.test(src)
    );
    expect(adjudications.length).toBeGreaterThan(0);
    expect(transfers.some((t) => t.table === "entityClaims")).toBe(false);
  });
});
