import { eq, sql } from "drizzle-orm";
import type { getCloudflareDb } from "@/lib/cloudflare";
import { users } from "@/lib/db/schema";

/**
 * OPE-1366 — end every session the user already holds.
 *
 * Increments users.session_version. Web JWTs carrying the old value are
 * refused at their next re-check (<= 5 min, src/lib/auth/session-refresh.ts);
 * MCP OAuth grants are refused at their next refresh (access tokens live 1 h,
 * mcp-server/src/oauth/token-exchange.ts). Relative increment, so two
 * concurrent bumps both land.
 */
export async function bumpSessionVersion(
  db: ReturnType<typeof getCloudflareDb>,
  userId: string
): Promise<void> {
  await db
    .update(users)
    .set({ sessionVersion: sql`session_version + 1` })
    .where(eq(users.id, userId));
}
