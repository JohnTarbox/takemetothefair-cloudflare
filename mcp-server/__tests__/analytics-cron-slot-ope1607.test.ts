import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * OPE-1607 — the analytics jobs must stay out of the 06:00 daily batch.
 *
 * As siblings there they failed with "D1 DB is overloaded" at 06:00:27-30 on
 * 11-06, 11-09 and 11-10. Nothing at runtime says which batch a task belongs
 * to, and a dispatch branch for a cron missing from wrangler.toml never fires,
 * so both halves are asserted against the source.
 */
const dir = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(dir, "../src/index.ts"), "utf8");
const WRANGLER = readFileSync(path.join(dir, "../wrangler.toml"), "utf8");

const SLOT = "25 6 * * *";
const MOVED = [
  "runScheduledGscMetricsSync(env)",
  "runScheduledPhotoCoverageScan(env)",
  "runScheduledImageUrlHealthSweep(env)",
  "runScheduledHeroProposals(env)",
];

const branchStart = SRC.indexOf(`if (controller.cron === "${SLOT}") {`);
const branchEnd = SRC.indexOf('if (controller.cron === "0 7 * * *") {');
const batchStart = SRC.indexOf("// Default daily branch");
const branch = SRC.slice(branchStart, branchEnd);
// Everything after the marker is the default batch; the helpers' definitions
// sit earlier in the file, so they cannot match here.
const batch = SRC.slice(batchStart);

describe("analytics cron slot (OPE-1607)", () => {
  it("locates the branch and the batch (guards against the anchors rotting)", () => {
    expect(branchStart).toBeGreaterThan(-1);
    expect(branchEnd).toBeGreaterThan(branchStart);
    expect(batchStart).toBeGreaterThan(branchEnd);
    // Landmark: a task that stays in the batch must still be found there.
    expect(batch).toContain("runScheduledGa4LivenessCheck(env)");
  });

  it.each(MOVED)("%s runs in the 06:25 branch", (call) => {
    expect(branch).toContain(call);
  });

  it.each(MOVED)("%s is not in the 06:00 batch", (call) => {
    expect(batch).not.toContain(call);
  });

  it("registers the trigger in wrangler.toml", () => {
    const crons = WRANGLER.match(/^crons = \[(.*)\]$/m)?.[1] ?? "";
    expect(crons).toContain(`"0 6 * * *"`);
    expect(crons).toContain(`"${SLOT}"`);
  });
});
