/**
 * MCP-side mirror of src/lib/feedback-tokens.ts. See that file for full
 * docs. Shared D1 schema means both surfaces write/consume the same
 * rows — the only difference is the drizzle import path.
 *
 * Keep this file in sync with the main-app twin when touching either.
 * Two duplicates is the cost of avoiding a shared workspace package
 * just for one helper.
 */

import { eq, and, isNull } from "drizzle-orm";
import { inboundEmailFeedbackTokens } from "./schema.js";
import type { Db } from "./db.js";

export type FeedbackMoment = "receipt" | "approval" | "other";

const TOKEN_BYTES = 32;
const TOKEN_TTL_DAYS = 60;

export interface IssueArgs {
  inboundEmailId: string;
  feedbackMoment: FeedbackMoment;
  resultingEventId?: string | null;
  ttlDays?: number;
}

export async function issueToken(db: Db, args: IssueArgs): Promise<string> {
  const raw = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(raw);
  const token = base64UrlEncode(raw);

  const now = new Date();
  const ttlDays = args.ttlDays ?? TOKEN_TTL_DAYS;
  const expiresAt = new Date(now.getTime() + ttlDays * 86400 * 1000);

  await db.insert(inboundEmailFeedbackTokens).values({
    token,
    inboundEmailId: args.inboundEmailId,
    feedbackMoment: args.feedbackMoment,
    resultingEventId: args.resultingEventId ?? null,
    issuedAt: now,
    expiresAt,
    usedAt: null,
  });

  return token;
}

export interface TokenMetadata {
  inboundEmailId: string;
  feedbackMoment: FeedbackMoment;
  resultingEventId: string | null;
}

export async function consumeToken(db: Db, rawToken: string): Promise<TokenMetadata | null> {
  if (!rawToken || rawToken.length < 16) return null;
  const rows = await db
    .select({
      inboundEmailId: inboundEmailFeedbackTokens.inboundEmailId,
      feedbackMoment: inboundEmailFeedbackTokens.feedbackMoment,
      resultingEventId: inboundEmailFeedbackTokens.resultingEventId,
      expiresAt: inboundEmailFeedbackTokens.expiresAt,
      usedAt: inboundEmailFeedbackTokens.usedAt,
    })
    .from(inboundEmailFeedbackTokens)
    .where(eq(inboundEmailFeedbackTokens.token, rawToken))
    .limit(1);
  if (rows.length === 0) return null;
  const row = rows[0];
  if (row.usedAt !== null) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;

  const updated = await db
    .update(inboundEmailFeedbackTokens)
    .set({ usedAt: new Date() })
    .where(
      and(eq(inboundEmailFeedbackTokens.token, rawToken), isNull(inboundEmailFeedbackTokens.usedAt))
    )
    .returning({ token: inboundEmailFeedbackTokens.token });
  if (updated.length === 0) return null;

  return {
    inboundEmailId: row.inboundEmailId,
    feedbackMoment: row.feedbackMoment as FeedbackMoment,
    resultingEventId: row.resultingEventId,
  };
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
