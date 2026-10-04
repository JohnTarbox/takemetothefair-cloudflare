/**
 * OPE-899 — ISR revalidation runs on OpenNext's Durable Object queue, and the
 * three pieces it needs are all declared. Structural on purpose: each is a
 * deploy-time contract a unit test cannot exercise, and a missing one fails
 * silently at request time (the DO constructor throws IgnorableError without
 * WORKER_SELF_REFERENCE; the override throws IgnorableError without the binding).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readWranglerConfig, wranglerTables } from "../../../scripts/lib/wrangler-config";

const root = join(__dirname, "../../..");
const config = readFileSync(join(root, "open-next.config.ts"), "utf8");
// OPE-1292 — parsed. The regexes this replaced needed each key on the very
// next line of its table, and the migration one would also match a comment.
const wrangler = readWranglerConfig("main", root);
/** Code only — the comment above the config quotes the old value. */
const configCode = config
  .split("\n")
  .filter((l) => !l.trim().startsWith("//"))
  .join("\n");

describe("OPE-899 — OpenNext DO revalidation queue", () => {
  it("the config uses the DO queue override, not the debug-only direct queue", () => {
    expect(configCode).toMatch(/from "@opennextjs\/cloudflare\/overrides\/queue\/do-queue"/);
    expect(configCode).toMatch(/queue:\s*doQueue/);
    expect(configCode).not.toMatch(/queue:\s*"direct"/);
    expect(configCode).toMatch(/incrementalCache:\s*r2IncrementalCache/); // landmark
  });

  it("wrangler binds NEXT_CACHE_DO_QUEUE to DOQueueHandler with a SQLite migration", () => {
    const bindings = wranglerTables(wrangler, "durable_objects.bindings");
    expect(bindings.length).toBeGreaterThan(0); // landmark: the table parsed
    expect(bindings).toContainEqual(
      expect.objectContaining({ name: "NEXT_CACHE_DO_QUEUE", class_name: "DOQueueHandler" })
    );
    const sqliteClasses = wranglerTables(wrangler, "migrations").flatMap((m) =>
      Array.isArray(m.new_sqlite_classes) ? m.new_sqlite_classes : []
    );
    expect(sqliteClasses).toContain("DOQueueHandler");
  });

  it("WORKER_SELF_REFERENCE points at THIS Worker's own name", () => {
    expect(wrangler.name).toBe("meetmeatthefair-app"); // landmark
    expect(wranglerTables(wrangler, "services")).toContainEqual(
      expect.objectContaining({ binding: "WORKER_SELF_REFERENCE", service: wrangler.name })
    );
  });
});
