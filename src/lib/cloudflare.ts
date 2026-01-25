import { getRequestContext } from "@cloudflare/next-on-pages";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./db/schema";

export function getCloudflareDb() {
  const { env } = getRequestContext();
  return drizzle(env.DB, { schema });
}

export function getCloudflareEnv() {
  const { env } = getRequestContext();
  return env;
}
