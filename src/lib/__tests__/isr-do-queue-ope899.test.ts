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

const root = join(__dirname, "../../..");
const config = readFileSync(join(root, "open-next.config.ts"), "utf8");
const wrangler = readFileSync(join(root, "wrangler.toml"), "utf8");
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
    expect(wrangler).toMatch(
      /\[\[durable_objects\.bindings\]\]\s*\nname = "NEXT_CACHE_DO_QUEUE"\s*\nclass_name = "DOQueueHandler"/
    );
    expect(wrangler).toMatch(/new_sqlite_classes = \["DOQueueHandler"\]/);
  });

  it("WORKER_SELF_REFERENCE points at THIS Worker's own name", () => {
    const name = /^name = "([^"]+)"/m.exec(wrangler)?.[1];
    expect(name).toBe("meetmeatthefair-app"); // landmark
    expect(wrangler).toMatch(
      new RegExp(
        `\\[\\[services\\]\\]\\s*\\nbinding = "WORKER_SELF_REFERENCE"\\s*\\nservice = "${name}"`
      )
    );
  });
});
