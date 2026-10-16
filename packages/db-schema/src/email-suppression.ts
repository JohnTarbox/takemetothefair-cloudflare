/**
 * OPE-1396 (DUP8) — "is this address on `email_suppression_list`?", in one
 * place both deploy artifacts import.
 *
 * The submission receipt checked it (src/lib/email/submission-received.ts) but
 * the approval notification (app + MCP twins) and the salvage notification did
 * not, so an address that unsubscribed, bounced or complained could still be
 * mailed "your submission is live". Same check, same normalization: the list
 * stores addresses lowercased (`email` is the primary key).
 */
import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./index";
import { emailSuppressionList } from "./index";

type Db = DrizzleD1Database<typeof schema>;

export async function isEmailSuppressed(
  db: Db,
  email: string | null | undefined
): Promise<boolean> {
  const normalized = (email ?? "").trim().toLowerCase();
  if (!normalized) return false;
  const [row] = await db
    .select({ email: emailSuppressionList.email })
    .from(emailSuppressionList)
    .where(eq(emailSuppressionList.email, normalized))
    .limit(1);
  return Boolean(row);
}
