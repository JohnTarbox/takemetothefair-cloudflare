/**
 * OPE-907 — the WORKERD test project for the MCP Worker.
 *
 * `vitest.config.ts` runs the Node suite (forks pool, better-sqlite3 standing in
 * for D1, hand-written fakes for Durable Object storage). Those tests cannot see
 * a defect that only exists in the real runtime: D1's own SQL dialect and bind
 * rules, the drizzle D1 driver's wire shape, a SQLite-backed Durable Object's
 * synchronous `ctx.storage.kv`, alarms, RPC serialization, input gates.
 *
 * This config runs `workerd-tests/**` INSIDE workerd via miniflare, using
 * @cloudflare/vitest-plugin. It is a separate config (not a `projects` entry)
 * so the Node suite's pool, aliases and includes stay exactly as they were.
 *
 * Bindings are declared here rather than read from `wrangler.toml`: the real
 * config also binds Workers AI, a service binding to the main app, Workflows
 * and send_email, none of which can run locally without remote access. Only
 * what the tests exercise is bound, and every binding is local:
 *   - DB             — a local D1, migrated from the repo's real `drizzle/`
 *                      directory (the same files `wrangler d1 migrations apply`
 *                      runs). The files are read here in Node and handed in as
 *                      TEST_MIGRATIONS; the D1 test file applies them itself,
 *                      so the Durable Object tests do not depend on D1.
 *   - BURST_COUNTER  — the real `BurstCounter` class (src/burst-counter.ts),
 *                      SQLite-backed like the `new_sqlite_classes` migration.
 *
 * `compatibilityDate` / `compatibilityFlags` mirror `wrangler.toml`.
 */
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(__dirname, "..", "drizzle"));
      return {
        main: "./workerd-tests/worker.ts",
        miniflare: {
          compatibilityDate: "2026-09-10",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: ["DB"],
          durableObjects: {
            BURST_COUNTER: { className: "BurstCounter", useSQLite: true },
          },
          bindings: { TEST_MIGRATIONS: migrations },
        },
      };
    }),
  ],
  test: {
    include: ["workerd-tests/**/*.test.ts"],
  },
});
