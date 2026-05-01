import type { Config } from "drizzle-kit";

export default {
  schema: "./packages/db-schema/src/index.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: ".wrangler/state/v3/d1/miniflare-D1DatabaseObject/local.sqlite",
  },
} satisfies Config;
