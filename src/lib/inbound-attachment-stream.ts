/**
 * OPE-409 — the one place inbound-email attachment bytes are served from.
 *
 * Extracted from `/api/admin/inbound-emails/[id]/attachments/[index]` when the
 * token-gated download route was added, so the two entry points cannot drift.
 * They authenticate differently on purpose — an admin session or the internal
 * key on one, a short-lived slot token on the other — but what they will serve,
 * and the headers they serve it under, must be identical. Two copies of the
 * `inbound-attachments/` prefix guard or of the inline-type allow-list is how
 * one of them ends up quietly weaker than the other.
 */
import { NextResponse } from "next/server";
import { inboundEmails } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";

export interface AttachmentRef {
  key: string;
  name: string;
  mimeType: string;
  size: number;
}

/**
 * XSS defence: `mimeType` is attacker-influenced — it comes off an inbound
 * email. Only KNOWN-SAFE raster/PDF types render inline; crucially NOT
 * `image/svg+xml`, which is an `image/*` type that executes script, and not
 * `text/html`. Everything else is forced to a download.
 */
const SAFE_INLINE = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "application/pdf",
]);

export type AttachmentLookupError =
  | { error: "bad_index"; status: 400 }
  | { error: "not_found"; status: 404 }
  | { error: "bad_refs"; status: 500 }
  | { error: "forbidden_key"; status: 403 }
  | { error: "storage_unavailable"; status: 503 }
  | { error: "object_missing"; status: 404 };

/**
 * Resolve one attachment ref, guarding the prefix. Returns the ref or a typed
 * error the caller renders — never throws for ordinary "not there" cases.
 */
export async function resolveAttachmentRef(
  db: DrizzleD1Database<Record<string, unknown>>,
  inboundEmailId: string,
  idx: number
): Promise<{ ok: true; ref: AttachmentRef } | { ok: false; err: AttachmentLookupError }> {
  if (!Number.isInteger(idx) || idx < 0) {
    return { ok: false, err: { error: "bad_index", status: 400 } };
  }
  const [row] = await db
    .select({ attachmentRefs: inboundEmails.attachmentRefs })
    .from(inboundEmails)
    .where(eq(inboundEmails.id, inboundEmailId))
    .limit(1);
  if (!row || !row.attachmentRefs) {
    return { ok: false, err: { error: "not_found", status: 404 } };
  }
  let refs: AttachmentRef[];
  try {
    refs = JSON.parse(row.attachmentRefs) as AttachmentRef[];
  } catch {
    return { ok: false, err: { error: "bad_refs", status: 500 } };
  }
  const ref = Array.isArray(refs) ? refs[idx] : undefined;
  if (!ref || typeof ref.key !== "string") {
    return { ok: false, err: { error: "not_found", status: 404 } };
  }
  // Defence in depth: only keys under this prefix are ever served, so a
  // tampered or legacy ref cannot read an arbitrary R2 object.
  if (!ref.key.startsWith("inbound-attachments/")) {
    return { ok: false, err: { error: "forbidden_key", status: 403 } };
  }
  return { ok: true, ref };
}

/** Stream the object for a resolved ref, with the private-content headers. */
export async function streamAttachment(
  bucket: R2Bucket | undefined,
  ref: AttachmentRef,
  idx: number,
  opts: { download: boolean }
): Promise<NextResponse> {
  if (!bucket) {
    return NextResponse.json({ error: "storage_unavailable" }, { status: 503 });
  }
  const obj = await bucket.get(ref.key);
  if (!obj) {
    return NextResponse.json({ error: "object_missing" }, { status: 404 });
  }

  const mime = ref.mimeType || obj.httpMetadata?.contentType || "application/octet-stream";
  // Strip characters that could break the Content-Disposition header.
  const safeName = (ref.name || `attachment-${idx}`).replace(/[\r\n"\\]/g, "_");
  const inline = !opts.download && SAFE_INLINE.has(mime.toLowerCase());

  return new NextResponse(obj.body, {
    headers: {
      "Content-Type": mime,
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${safeName}"`,
      // Private admin content — never cache in shared/edge caches. Doubly so on
      // the token route: a cached response would outlive the slot's TTL, which
      // is the only thing bounding a leaked token.
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}
