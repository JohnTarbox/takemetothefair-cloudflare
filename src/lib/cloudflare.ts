import { getRequestContext } from "@cloudflare/next-on-pages";
import { getDb } from "./db";

export function getCloudflareDb() {
  const ctx = getRequestContext();
  return getDb(ctx.env.DB);
}

export function getCloudflareEnv() {
  const ctx = getRequestContext();
  return ctx.env;
}
