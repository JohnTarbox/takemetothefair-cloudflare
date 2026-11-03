/**
 * K7.4 / OPE-1408 — what the AI extractor was about to see, written to the
 * inbound_emails row BEFORE the AI call (drizzle/0094 columns
 * `content_length_chars` + `content_sha256_first16`). The pair clusters
 * identical pages on /admin/source-quality ("this URL's content has failed 12
 * times with the same hash") and tells "the page was empty" apart from "the AI
 * failed on a real page".
 *
 * Extracted from the single-URL submit path in OPE-1408. The writer lived
 * ONLY there, and the multi-source fan-out (OPE-55, 2026-07-02) never called
 * it; on 2026-08-24 OPE-537 (#1019) routed every bare-URL email into the
 * fan-out, so from that day nothing in prod reached it. The last row it wrote
 * is 2496a417, 2026-08-24 15:22:11 UTC — 26 minutes before #1019 merged.
 * Sharing one function is the fix: every URL fetch that feeds `submitExtract`
 * calls this, and a source-level guard pins that.
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db.js";
import { inboundEmails } from "../schema.js";

export interface ExtractContext {
  contentLengthChars: number;
  contentSha256First16: string;
}

/** Length in UTF-16 code units (JS `.length`, as the column always held) + the first 16 hex chars of SHA-256. */
export async function computeExtractContext(content: string): Promise<ExtractContext> {
  const enc = new TextEncoder().encode(content);
  const hashBuf = await crypto.subtle.digest("SHA-256", enc);
  const hashHex = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
  return { contentLengthChars: content.length, contentSha256First16: hashHex };
}

/**
 * Write the extract context onto the inbound_emails row. Throws on a D1 error —
 * the caller owns the failsoft (telemetry is not load-bearing).
 */
export async function persistExtractContext(
  db: Db,
  messageRowId: string,
  content: string
): Promise<ExtractContext> {
  const ctx = await computeExtractContext(content);
  await db
    .update(inboundEmails)
    .set({
      contentLengthChars: ctx.contentLengthChars,
      contentSha256First16: ctx.contentSha256First16,
    })
    .where(eq(inboundEmails.id, messageRowId));
  return ctx;
}
