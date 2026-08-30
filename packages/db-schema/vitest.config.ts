import { defineConfig } from "vitest/config";

/**
 * OPE-391 — this package had NO vitest config, so `npm test --workspace
 * @takemetothefair/db-schema` inherited the repo-root one, which loads
 * `src/test/setup.ts` (an app path that does not exist here). The script
 * survived only because `--passWithNoTests` made a broken config look like an
 * empty one; adding the first test file turned it into a hard failure.
 *
 * Mirrors packages/utils/vitest.config.ts.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.ts"],
  },
});
