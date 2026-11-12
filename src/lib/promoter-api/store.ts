/**
 * OPE-1620 — the D1 side of the promoter API's keys and replay ledger.
 * Server-only (Workers runtime): randomness comes from crypto.getRandomValues.
 */
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import type { getCloudflareDb } from "@/lib/cloudflare";
import { promoterApiKeys, promoterApiRequests, promoters } from "@/lib/db/schema";
import type { ApiKeyRecord } from "./auth";

type Db = ReturnType<typeof getCloudflareDb>;

/** Request ids are kept this long; a replay older than the ±300 s skew is refused anyway. */
export const REQUEST_ID_RETENTION_SECONDS = 86_400;
export const MAX_ACTIVE_KEYS_PER_PROMOTER = 10;

const randomHex = (bytes: number) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

/** key_id: `mmk_` + 24 hex (12 random bytes). secret: 64 hex (32 random bytes). */
export function generateKeyMaterial(): { keyId: string; secret: string } {
  return { keyId: `mmk_${randomHex(12)}`, secret: randomHex(32) };
}

export async function lookupApiKey(db: Db, keyId: string): Promise<ApiKeyRecord | null> {
  const [row] = await db
    .select({
      keyId: promoterApiKeys.keyId,
      secret: promoterApiKeys.secret,
      promoterId: promoterApiKeys.promoterId,
      promoterUserId: promoters.userId,
      revokedAt: promoterApiKeys.revokedAt,
      isTest: promoterApiKeys.isTest,
    })
    .from(promoterApiKeys)
    .innerJoin(promoters, eq(promoters.id, promoterApiKeys.promoterId))
    .where(eq(promoterApiKeys.keyId, keyId))
    .limit(1);
  return row ? { ...row, isTest: !!row.isTest } : null;
}

/**
 * Record (key, request id). False when it was already there: a replay. Prunes
 * rows older than a day first, so the table holds at most a day of requests.
 */
export async function consumeRequestId(
  db: Db,
  keyId: string,
  requestId: string,
  now: Date
): Promise<boolean> {
  await db
    .delete(promoterApiRequests)
    .where(
      lt(
        promoterApiRequests.createdAt,
        new Date(now.getTime() - REQUEST_ID_RETENTION_SECONDS * 1000)
      )
    );
  const res = await db
    .insert(promoterApiRequests)
    .values({ keyId, requestId, createdAt: now })
    .onConflictDoNothing()
    .returning({ keyId: promoterApiRequests.keyId });
  return res.length > 0;
}

export async function touchApiKey(db: Db, keyId: string, now: Date): Promise<void> {
  await db.update(promoterApiKeys).set({ lastUsedAt: now }).where(eq(promoterApiKeys.keyId, keyId));
}

export async function createApiKey(
  db: Db,
  args: { promoterId: string; name: string; userId: string; now: Date; isTest?: boolean }
): Promise<
  | { keyId: string; secret: string; name: string; createdAt: Date; isTest: boolean }
  | { error: string }
> {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(promoterApiKeys)
    .where(and(eq(promoterApiKeys.promoterId, args.promoterId), isNull(promoterApiKeys.revokedAt)));
  if (n >= MAX_ACTIVE_KEYS_PER_PROMOTER)
    return {
      error: `You already have ${MAX_ACTIVE_KEYS_PER_PROMOTER} active keys. Revoke one you no longer use first.`,
    };
  const { keyId, secret } = generateKeyMaterial();
  await db.insert(promoterApiKeys).values({
    promoterId: args.promoterId,
    name: args.name,
    keyId,
    secret,
    createdByUserId: args.userId,
    createdAt: args.now,
    isTest: !!args.isTest,
  });
  return { keyId, secret, name: args.name, createdAt: args.now, isTest: !!args.isTest };
}

/** A promoter's keys, newest first — never the secret. */
export async function listApiKeys(db: Db, promoterId: string) {
  return db
    .select({
      key_id: promoterApiKeys.keyId,
      name: promoterApiKeys.name,
      created_at: promoterApiKeys.createdAt,
      last_used_at: promoterApiKeys.lastUsedAt,
      revoked_at: promoterApiKeys.revokedAt,
      test: promoterApiKeys.isTest,
    })
    .from(promoterApiKeys)
    .where(eq(promoterApiKeys.promoterId, promoterId))
    .orderBy(desc(promoterApiKeys.createdAt))
    .limit(100);
}

/** Revoke one of THIS promoter's keys. False when there is no such active key. */
export async function revokeApiKey(
  db: Db,
  args: { promoterId: string; keyId: string; now: Date }
): Promise<boolean> {
  const res = await db
    .update(promoterApiKeys)
    .set({ revokedAt: args.now })
    .where(
      and(
        eq(promoterApiKeys.promoterId, args.promoterId),
        eq(promoterApiKeys.keyId, args.keyId),
        isNull(promoterApiKeys.revokedAt)
      )
    )
    .returning({ keyId: promoterApiKeys.keyId });
  return res.length > 0;
}
