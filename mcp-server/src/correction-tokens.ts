/**
 * MCP-side mirror of src/lib/correction-tokens.ts. See that file for full
 * docs. Shared D1 schema (drizzle/0085 submission_correction_tokens) means
 * both surfaces write/consume the same rows — the only difference is the
 * drizzle import path.
 *
 * Keep this file in sync with the main-app twin when touching either.
 * Same trade-off the feedback-tokens.ts twin made: two duplicates is the
 * cost of avoiding a shared workspace package for a single helper.
 *
 * The workflow only needs the WRITE half (issue) — verify + consume live
 * in the main app's GET/POST /submit-event/[token] route. We export only
 * issueCorrectionToken here to make the intent explicit.
 */

import { submissionCorrectionTokens } from "./schema.js";
import type { Db } from "./db.js";

const TOKEN_BYTES = 32;
const TOKEN_TTL_DAYS = 30;

/** Mint a new correction token and persist it. Returns the bare token
 *  string. Caller composes the URL via
 *  `${MAIN_APP_URL}/submit-event/${token}`. */
export async function issueCorrectionToken(
  db: Db,
  args: { eventId: string; inboundEmailId: string }
): Promise<string> {
  const raw = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(raw);
  const token = base64UrlEncode(raw);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  await db.insert(submissionCorrectionTokens).values({
    token,
    eventId: args.eventId,
    inboundEmailId: args.inboundEmailId,
    expiresAt,
    usedAt: null,
    createdAt: now,
  });
  return token;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
