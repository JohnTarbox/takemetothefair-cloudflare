/**
 * OPE-408 — every venue writer must route through the geocode gate.
 *
 * ── Why a source-level scan and not a behavioural test ──────────────────────
 * This defect has now reopened three times, and every recurrence is the same
 * shape: a NEW writer appears that does not know the gate exists.
 *
 *   OPE-207 (2026-07)  shipped `venues_geocode` "for batch backfill AND every
 *                      future new venue" — and wired 0 of the writers.
 *   OPE-408 (08-16)    wired 4 main-app writers, and left the two in the MCP
 *                      Worker plus the sweep's own caller untouched.
 *   OPE-541 (08-24)    added `venue-minting.ts`, an eighth writer, which
 *                      forgot again — eight days after the fix.
 *
 * Measured in prod on 2026-08-28: of 29 venues created since the OPE-408 fix
 * landed, 3 had no pin, and 2 of those carried a resolvable street address —
 * `MGM Springfield` (One MGM Way, 08-21) and `Hilton Garden Inn Auburn
 * Riverwatch` (14 Great Falls Plaza, 08-25). Both had `updated_at ==
 * created_at`: nothing had touched them since birth.
 *
 * A behavioural test of any single writer would have passed on every one of
 * those three occasions, because the covered writers were always fine. What
 * needs asserting is that NO `insert(venues)` anywhere skips the gate — which
 * is a property of the set of writers, not of any member of it.
 *
 * ── Why per-file rather than per-call-site ─────────────────────────────────
 * The geocode call deliberately does not sit adjacent to the insert: the MCP
 * writers geocode after their IndexNow ping, and `venue-minting` geocodes after
 * its race-recovery catch. A proximity window would fail on correct code.
 * Owning the insert and owning the gate is a file-level responsibility here.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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

/**
 * Every non-test source file in the workspace that inserts into `venues`.
 *
 * Comments are stripped FIRST and it matters more here than usual: four files
 * in this codebase discuss `insert(venues)` in prose — `venue-matching.ts`'s
 * contract note, `geocode-one.ts`'s docblock, and this ticket's own commentary
 * in two writers. A scanner that counts its own documentation as a call site
 * reports failures nobody can fix.
 */
function venueInsertFiles(): string[] {
  const hits = new Set<string>();
  for (const dir of ["src", "packages", "mcp-server/src"]) {
    for (const f of walk(join(ROOT, dir))) {
      const src = readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      if (/\.insert\(\s*(?:schema\.)?venues\s*\)/.test(src)) {
        hits.add(f.slice(ROOT.length + 1));
      }
    }
  }
  return [...hits].sort();
}

/**
 * The gate, in its two forms: the direct call for main-app writers, and the
 * X-Internal-Key proxy for the MCP Worker, which is a separate build with no
 * path into `src/`.
 *
 * Both patterns require the opening paren. A bare symbol would also match the
 * `import { geocodeNewVenue } from ...` line, and this assertion would go
 * vacuously green on a file that imports the gate and never calls it.
 */
const GATE = /\bgeocodeNewVenue\(|\bgeocodeNewVenueViaMainApp\(/;

describe("OPE-408 — every venue writer geocodes", () => {
  const files = venueInsertFiles();

  it("finds the known writers — the scan is not vacuous", () => {
    // Seven at the time of writing. If this number drops, the scanner broke
    // (a renamed helper, a changed call shape) and every assertion below would
    // pass by finding nothing — the exact way this class of guard dies quietly.
    expect(files).toEqual([
      "mcp-server/src/tools/admin.ts",
      "mcp-server/src/tools/vendor.ts",
      "src/app/api/admin/import-url/route.ts",
      "src/app/api/admin/import/route.ts",
      "src/app/api/admin/venues/route.ts",
      "src/app/api/venues/route.ts",
      "src/lib/venue-minting.ts",
    ]);
  });

  it.each(venueInsertFiles())("%s routes its new venue through the geocode gate", (file) => {
    const src = readFileSync(join(ROOT, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(src).toMatch(GATE);
  });
});

/**
 * The sweep's liveness signal, pinned across all three artifacts that have to
 * agree about it.
 *
 * This is the failure the 4b membrane already shipped once and nobody noticed
 * for weeks: a trigger that watches for a string its producer never writes is
 * not a trigger, it is a permanently-green no-op. `membrane_crossings` holds
 * zero `review_to_rework` rows for exactly that reason — the watcher matched on
 * a marker the reviewers had never used.
 *
 * Here the same three-way agreement is required: the route WRITES an action
 * string, the probe FILTERS on it, and the migration SEEDS a probe row by name.
 * Any one of the three drifting makes the probe silently useless while every
 * other test in this file still passes.
 */
describe("OPE-408 — the sweep probe watches a string the sweep actually writes", () => {
  const SWEEP_ACTION = "venue.geocode.sweep";
  const PROBE_NAME = "venue-geocode-sweep";

  const route = readFileSync(
    join(ROOT, "src/app/api/admin/venues/geocode-venues/route.ts"),
    "utf8"
  );
  const heartbeat = readFileSync(join(ROOT, "src/lib/heartbeat.ts"), "utf8");
  const migration = readFileSync(
    join(ROOT, "drizzle/0242_ope408_venue_geocode_sweep_probe.sql"),
    "utf8"
  );

  it("the route writes the action on a missing_only sweep", () => {
    // Anchored on the field syntax, not the bare string: the docblock above the
    // insert names the action too, and matching prose would pass with the
    // insert deleted.
    expect(route).toContain(`action: "${SWEEP_ACTION}"`);
    // ...and only for the cron's own call shape. An explicit id list is a human
    // calling the tool by hand and must not refresh the cron's liveness.
    expect(route).toContain("if (body.missing_only) {");
  });

  it("the probe filters on that same action", () => {
    expect(heartbeat).toContain(`eq(adminActions.action, "${SWEEP_ACTION}")`);
    expect(heartbeat).toContain(`name: "${PROBE_NAME}"`);
  });

  it("the migration seeds a row under that probe name", () => {
    expect(migration).toContain(`'${PROBE_NAME}'`);
    // enabled_at must be a real timestamp, not NULL: the writer ships in the
    // same PR behind no flag, so a dormant probe would just hide it.
    expect(migration).toMatch(/enabled_at[\s\S]*?unixepoch\(\)/);
  });
});
