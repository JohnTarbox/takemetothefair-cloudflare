/**
 * OPE-975 — scripts/check-heartbeat-probes.ts, driven to failure on real files.
 *
 * The check is only worth anything if it goes red for the thing it claims to
 * catch. Each refusal below is paired with the clean run on the real tree, and
 * the seed-row case deletes a REAL seed from a copy of drizzle/ rather than
 * feeding the checker a list written to fail.
 */
import { describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkIntegrity,
  discoverPaths,
  registryNames,
  runCheck,
  seededNames,
} from "../../../scripts/check-heartbeat-probes";
import { HEARTBEAT_PROBES } from "@/lib/heartbeat";
import { GRANDFATHERED_UNREVIEWED, HEARTBEAT_INVENTORY } from "@/lib/heartbeat-inventory";

const ROOT = join(__dirname, "../../..");
const base = () => ({
  registry: ["a", "b"],
  seeded: ["a", "b"],
  paths: ["queue:x", "cron:runY"],
  inventory: { "queue:x": { probes: ["a"] }, "cron:runY": { probes: ["b"] } } as Record<
    string,
    Parameters<typeof checkIntegrity>[0]["inventory"][string]
  >,
  grandfathered: new Set<string>(),
});

describe("OPE-975 — the real tree", () => {
  it("LANDMARK: passes, and says what it examined", () => {
    const r = runCheck(ROOT);
    expect(r.errors).toEqual([]);
    expect(r.summary).toMatch(
      /\d+ registered, \d+ seeded\. execution paths: \d+ examined, \d+ probed/
    );
  });

  it("parses the registry exactly as the code sees it", () => {
    const parsed = registryNames(readFileSync(join(ROOT, "src/lib/heartbeat.ts"), "utf8"));
    expect(parsed).toEqual(HEARTBEAT_PROBES.map((p) => p.name));
  });

  it("discovers the declared paths: 7 queue consumers, 4 Workflows, and the scheduled jobs", () => {
    const paths = discoverPaths(
      readFileSync(join(ROOT, "mcp-server/wrangler.toml"), "utf8"),
      readFileSync(join(ROOT, "mcp-server/src/index.ts"), "utf8")
    );
    expect(paths.filter((p) => p.startsWith("queue:"))).toHaveLength(7);
    expect(paths.filter((p) => p.startsWith("workflow:"))).toHaveLength(4);
    expect(paths).toContain("cron:runScheduledBurstCapSelfTest");
    expect(paths).toContain("cron:main-app:/api/admin/venues/geocode-venues");
    expect(Object.keys(HEARTBEAT_INVENTORY).sort()).toEqual(paths);
  });

  it("the grandfathered set only ever shrinks: every member is still an unreviewed entry", () => {
    for (const p of GRANDFATHERED_UNREVIEWED) {
      expect(HEARTBEAT_INVENTORY[p], p).toEqual({ unreviewed: "grandfathered-2026-09-13" });
    }
  });
});

describe("OPE-975 — driven to failure", () => {
  it("ACCEPTANCE: removing a REAL seed row (burst-cap-selftest, drizzle/0282) turns it red", () => {
    const dir = mkdtempSync(join(tmpdir(), "ope975-"));
    cpSync(join(ROOT, "drizzle"), dir, { recursive: true });
    const f = join(dir, "0282_ope951_burst_cap_selftest_probe.sql");
    const before = readFileSync(f, "utf8");
    const after = before.replace(/INSERT INTO heartbeat_probes[\s\S]*?;/, "SELECT 1;");
    expect(after).not.toBe(before); // the mutation landed
    writeFileSync(f, after);

    const seeded = seededNames(dir).names;
    expect(seeded).not.toContain("burst-cap-selftest");
    const registry = registryNames(readFileSync(join(ROOT, "src/lib/heartbeat.ts"), "utf8"));
    const r = checkIntegrity({ ...base(), registry, seeded, paths: [], inventory: {} });
    expect(r.errors).toEqual([expect.stringContaining('probe "burst-cap-selftest"')]);
  });

  it("catches an orphan seed — the rename-leaves-the-old-row case", () => {
    const r = checkIntegrity({ ...base(), seeded: ["a", "b", "old-name"] });
    expect(r.errors).toEqual([expect.stringContaining('seed row "old-name"')]);
  });

  it("ACCEPTANCE: a new path with no probe and no waiver fails, naming the path and BOTH remedies", () => {
    const r = checkIntegrity({ ...base(), paths: ["queue:x", "cron:runY", "cron:runNewWriter"] });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("cron:runNewWriter");
    expect(r.errors[0]).toContain("probes");
    expect(r.errors[0]).toContain("waiver");
  });

  it("a new path cannot defer the decision by marking itself unreviewed", () => {
    const b = base();
    b.paths.push("cron:runZ");
    b.inventory["cron:runZ"] = { unreviewed: "grandfathered-2026-09-13" };
    expect(checkIntegrity(b).errors).toEqual([
      expect.stringContaining('"cron:runZ" is marked unreviewed'),
    ]);
  });

  it("an entry naming a probe that does not exist fails — a probe-shaped name is not coverage", () => {
    const b = base();
    b.inventory["queue:x"] = { probes: ["a", "typo-probe"] };
    expect(checkIntegrity(b).errors).toEqual([expect.stringContaining('"typo-probe"')]);
  });

  it("a stale inventory entry for a removed path fails", () => {
    const b = base();
    b.inventory["queue:gone"] = { probes: ["a"] };
    expect(checkIntegrity(b).errors).toEqual([
      expect.stringContaining('"queue:gone" matches no current'),
    ]);
  });

  it("a waiver needs a reason and an owner", () => {
    const b = base();
    b.inventory["queue:x"] = { waiver: { reason: " ", decided: "2026-09-13", ope: "OPE-1" } };
    expect(checkIntegrity(b).errors).toEqual([expect.stringContaining("waiver with no reason")]);
  });
});

describe("OPE-975 — every probe's window is pinned", () => {
  // Changing a window is a decision about when silence becomes an alarm (the
  // OPE-830 72h-by-analogy error). It must show up as a deliberate edit here,
  // not ride along unnoticed in a larger diff.
  it("expectedWindowHours per probe", () => {
    expect(
      Object.fromEntries(HEARTBEAT_PROBES.map((p) => [p.name, p.expectedWindowHours]))
    ).toEqual({
      "roster-vendor-link": 720,
      "submit-secondary-page-crawl": 576,
      "spam-event-triple-detector": 504,
      "entity-write-log-writer": 336,
      "event-data-citations-writer": 72,
      "citation-source-snapshot": 504,
      "occurred-transition-sweep": 48,
      "gsc-sweep-filler-tiers": 48,
      "agent-silence-watchdog": 48,
      "inbound-held-submissions-snapshot": 48,
      "gsc-daily-totals": 48,
      "funnel-canary": 48,
      "verification-threshold-tuner": 48,
      "photo-intake": 30 * 24,
      "photo-intake-storage-record": 30 * 24,
      "ocr-attachment": 21 * 24,
      "email-send": 72,
      "email-delivery-events": 72,
      "inbound-submit": 21 * 24,
      "inbound-forward-analysis": 72,
      "newsletter-broadcast-weekend": 21 * 24,
      "newsletter-broadcast-vendor": 21 * 24,
      "promoter-url-health-sweep": 72,
      // OPE-987 — run stamp of a pass on the daily 06:00Z drift workflow: one
      // missed run tolerated, two not.
      "organizer-cancellation-recheck": 48,
      "source-agreement-sweep": 72,
      "vendor-enrichment": 7 * 24,
      "image-coverage-scan": 48,
      "image-url-health-sweep": 72,
      "photo-coverage-snapshot": 48,
      "vendor-claim-evidence": 30 * 24,
      "claim-corroboration-sweep": 48,
      "promoter-enrichment": 7 * 24,
      "discrepancy-detection": 72,
      "gw1d-scorer": 7 * 24,
      "booth-autowrite": 30 * 24,
      "series-write-path": 336,
      "venue-decision-writer": 336,
      "venue-geocode-sweep": 48,
      "inbound-citation-writer": 336,
      "email-defect-candidate-detector": 240,
      "newsletter-list-balance-canary": 48,
      "burst-cap-selftest": 48,
      "fault-emitter-run": 6,
      "gsc-search-metrics-ingest": 48,
      "ga4-daily-metrics-ingest": 48,
      "recommendation-scan": 48,
      "bing-liveness": 48,
      "site-health-refresh": 48,
      "membrane-crossing-ledger": 72,
      "promoter-outreach-attempts": 14 * 24,
      "gsc-monthly-oracle": 40 * 24,
      "vendor-self-reported-events": 30 * 24,
      "performer-enrichment-producer": 7 * 24,
      "request-sample-retention": 48,
      "error-log-retention": 48,
      "indexnow-submission-retention": 48,
    });
  });
});
