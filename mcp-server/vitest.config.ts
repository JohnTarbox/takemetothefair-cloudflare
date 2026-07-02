import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
    pool: "forks", // better-sqlite3 native binding doesn't share well across worker threads
    alias: {
      // The workers runtime provides `cloudflare:workflows` as a virtual
      // module. Under node-pool unit tests we substitute a stub with the
      // same NonRetryableError shape so submit.ts's import resolves.
      "cloudflare:workflows": resolve(__dirname, "__tests__/_mocks/cloudflare-workflows.ts"),
      // Same rationale for `cloudflare:workers` — the workers runtime
      // provides WorkflowEntrypoint as a virtual module; under node-pool
      // unit tests we substitute a stub so workflow classes import.
      "cloudflare:workers": resolve(__dirname, "__tests__/_mocks/cloudflare-workers.ts"),
    },
  },
});
