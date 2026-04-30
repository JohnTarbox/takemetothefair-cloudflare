import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
    pool: "forks", // better-sqlite3 native binding doesn't share well across worker threads
  },
});
