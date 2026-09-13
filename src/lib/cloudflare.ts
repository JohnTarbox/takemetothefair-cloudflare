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

/**
 * OPE-950 — the names in `CloudflareEnv` whose value is a string (a `[vars]`
 * entry or a secret), never a binding object. Lets a by-name reader
 * (`getRuntimeEnv("RESEND_API_KEY")`) index the typed env with no cast, and
 * makes a misspelled or undeclared key a type error instead of a silent
 * `undefined`.
 */
export type CloudflareStringEnvKey = {
  [K in keyof CloudflareEnv]-?: CloudflareEnv[K] extends string | undefined ? K : never;
}[keyof CloudflareEnv];

/**
 * OPE-950 — every string-valued env entry, for callers whose lookup really is
 * dynamic (a flag inventory resolved by name). Filters at runtime rather than
 * asserting `Record<string, string>` over an object that also holds D1/KV/R2
 * bindings.
 */
export function getCloudflareStringVars(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(getCloudflareEnv())) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

export function getCloudflareAi() {
  const { env } = getCloudflareContext();
  return env.AI;
}

export function getCloudflareRateLimitKv(): KVNamespace | null {
  try {
    const { env } = getCloudflareContext();
    return env.RATE_LIMIT_KV ?? null;
  } catch {
    // Off-CF runtime (local `next build` / tests): no KV binding available.
    // Callers treat null as "rate limiting unavailable" and fail open.
    return null;
  }
}
