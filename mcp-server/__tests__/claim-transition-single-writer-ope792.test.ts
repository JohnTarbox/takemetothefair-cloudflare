/**
 * OPE-792 — the claim transition has exactly ONE implementation.
 *
 * The defect was not a missing email. The email exists, is wired, and uses the
 * claim-identifiable ledger source `claims.decision`. The defect was a SECOND
 * implementation of the transition — the MCP tools performed the ownership
 * transfer, role grant, status flip and audit row themselves, and skipped the
 * two steps only `src/lib/claims/admin-review.ts` performs: the claimant
 * notification row and the decision email.
 *
 * That copy was not wrong when written. The email landed in the core later
 * (OPE-65, #645) and nothing carried it across. Three claims were approved
 * through the MCP path; `email_send_ledger` has never held a `claims.decision`
 * row; one claimant was written to by hand.
 *
 * ## Why this guard is keyed on the WRITE, not on the send
 *
 * A guard asserting "the MCP tool sends a decision email" would be satisfied by
 * a future third path that does neither — it would simply not be a tool this
 * guard knows to look at. Keying on the ACT (writing a claim transition) closes
 * it from the other side: any new code in the MCP runtime that decides a claim
 * itself fails here, whether or not it remembers the notification.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
  });
}

/**
 * `admin-claim-approval.ts` (`admin_approve_vendor_claim`) is a deliberate
 * manual override for the LEGACY `vendors.claimed` flag path, which predates
 * `entity_claims` and is the subject of OPE-236. It is exempt by name rather
 * than by pattern so the exemption is visible and has to be argued for.
 */
const EXEMPT = new Set(["admin-claim-approval.ts"]);

describe("OPE-792 — only one implementation decides a claim", () => {
  const files = walk(SRC);

  it("scanned a non-empty MCP source tree", () => {
    // Positive landmark. Without it, a broken walk() reports "no offenders"
    // and this whole file becomes a clean bill of health for nothing.
    expect(files.length).toBeGreaterThan(50);
  });

  it("no MCP source writes an entity_claims decision status directly", () => {
    const offenders: string[] = [];
    let examined = 0;
    for (const f of files) {
      if (EXEMPT.has(f.split("/").pop()!)) continue;
      const src = readFileSync(f, "utf8");
      if (!src.includes("entityClaims")) continue;
      examined++;
      // The act: setting a terminal decision status on the claims table.
      if (/\.set\(\{[^}]*status:\s*"(APPROVED|REJECTED)"/s.test(src)) {
        offenders.push(f.replace(process.cwd() + "/", ""));
      }
    }
    // Landmark again: at least one file must actually mention entityClaims, or
    // the `continue` above skipped everything and the assertion is vacuous.
    expect(examined).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  it("approve_claim / reject_claim forward to /api/admin/claims", () => {
    const src = readFileSync(join(SRC, "tools", "admin-claim-review.ts"), "utf8");
    expect(src).toContain("/api/admin/claims");
    expect(src).toContain("x-internal-key");
  });
});
