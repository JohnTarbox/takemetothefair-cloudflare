/**
 * OPE-238 — every owner-facing write route proves email control first.
 *
 * The gate was never missing; it was applied BY HAND, route by route, and four
 * were missed. That is why this is a structural test and not four unit tests:
 * the risk is not the routes we know about, it is the eleventh one somebody
 * adds next month.
 *
 * State when this was written (measured by this test's own scan):
 *   gated via requireVerifiedSession — vendor/profile PATCH,
 *     vendor/applications POST, vendor/self-reported-events PUT
 *   gated inline on users.emailVerified — vendor|promoter|performer
 *     /claim/direct POST
 *   MISSED — vendor/applications/[id] DELETE (its sibling POST was gated),
 *     vendor/claim/initiate POST, promoter/events POST, promoter/events/draft POST
 *
 * The first two are fixed here. The two promoter event-creation routes are
 * deliberately NOT, and are listed below as a known, visible gap: John's
 * 2026-08-31 approval covers the vendor badge and vendor profile-edit rights,
 * and silently extending a verification requirement to promoter event creation
 * would be a scope widening he did not authorise. Named rather than forgotten.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "..", "..", "..");
const API_ROOTS = ["src/app/api/vendor", "src/app/api/promoter", "src/app/api/performer"];

/**
 * Owner-facing write routes that do NOT require a verified email, each with a
 * reason. This list may shrink freely; growing it is a decision someone has to
 * defend in review, which is the entire point.
 */
const KNOWN_UNGATED: Record<string, string> = {
  // OPE-703 — EMPTY, and that is the goal state rather than an oversight.
  //
  // Both promoter event-creation routes were listed here when OPE-238 shipped,
  // because gating them exceeded the approval that covered the vendor badge and
  // vendor profile-edit. John approved them separately on 2026-08-31 and they
  // are now gated, so every owner-facing write in the three API trees proves
  // email control. An entry added here again is a deliberate, reviewable claim
  // that a route may write on an unverified session.
};

/** A route file proves email control if it does either of these. */
const EVIDENCE = ["requireVerifiedSession", "emailVerified"];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name === "route.ts") out.push(full);
  }
  return out;
}

const WRITE_METHOD = /export\s+(?:async\s+)?function\s+(POST|PATCH|PUT|DELETE)\b/;

describe("OPE-238 — owner-facing writes require a verified email", () => {
  const routes = API_ROOTS.flatMap((r) => walk(join(ROOT, r)))
    .map((f) => ({ rel: relative(ROOT, f).replace(/\\/g, "/"), src: readFileSync(f, "utf8") }))
    .filter((f) => WRITE_METHOD.test(f.src));

  it("finds the write routes at all (guards against a vacuous pass)", () => {
    // A structural test that scans nothing proves nothing. If a refactor moves
    // these directories, this fails loudly instead of going quietly green.
    expect(routes.length).toBeGreaterThanOrEqual(8);
    expect(routes.map((r) => r.rel)).toContain("src/app/api/vendor/profile/route.ts");
  });

  it.each([
    "src/app/api/vendor/profile/route.ts",
    "src/app/api/vendor/applications/route.ts",
    "src/app/api/vendor/applications/[id]/route.ts",
    "src/app/api/vendor/self-reported-events/route.ts",
    "src/app/api/vendor/claim/initiate/route.ts",
    "src/app/api/vendor/claim/direct/route.ts",
    // OPE-703 — the last two, approved by John 2026-08-31. Pinned positively
    // here as well as by the sweep below, so removing a gate fails a test that
    // NAMES the route rather than one that reports a count.
    "src/app/api/promoter/events/route.ts",
    "src/app/api/promoter/events/draft/route.ts",
  ])("%s requires a verified email before writing", (rel) => {
    const found = routes.find((r) => r.rel === rel);
    expect(found, `${rel} no longer exposes a write method`).toBeDefined();
    expect(EVIDENCE.some((e) => found!.src.includes(e))).toBe(true);
  });

  it("no NEW owner-facing write route is ungated", () => {
    const offenders = routes
      .filter((r) => !(r.rel in KNOWN_UNGATED))
      .filter((r) => !EVIDENCE.some((e) => r.src.includes(e)))
      .map((r) => r.rel);

    expect(
      offenders,
      "These expose a write method to a listing owner without proving email control. " +
        "Call requireVerifiedSession() (or check users.emailVerified inline, as the " +
        "claim/direct routes do), or add the file to KNOWN_UNGATED with a reason. See OPE-238."
    ).toEqual([]);
  });

  it("the known-ungated list is empty, and any entry carries a reason", () => {
    // A growing exemption list is the failure this guard would decay into. It
    // is empty as of OPE-703 and the cap is kept at 2 rather than 0 on purpose:
    // a legitimate exemption may exist one day, and forcing it to 0 would push
    // the next author to delete the guard instead of arguing for the entry.
    expect(Object.keys(KNOWN_UNGATED).length).toBeLessThanOrEqual(2);
    for (const [rel, reason] of Object.entries(KNOWN_UNGATED)) {
      expect(reason.length, `${rel} needs a real reason`).toBeGreaterThan(40);
    }
  });
});
