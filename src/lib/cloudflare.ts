import { getCloudflareContext } from "@opennextjs/cloudflare";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./db/schema";

export function getCloudflareDb() {
  const { env } = getCloudflareContext();
  return drizzle(env.DB, { schema });
}

export function getCloudflareEnv() {
  const { env } = getCloudflareContext();
  return env;
}

export function getCloudflareAi() {
  const { env } = getCloudflareContext();
  return env.AI;
}

export function getCloudflareRateLimitKv(): KVNamespace | null {
  try {
    const { env } = getCloudflareContext();
    return (env as { RATE_LIMIT_KV?: KVNamespace }).RATE_LIMIT_KV ?? null;
  } catch {
    return null;
  }
}
