/**
 * OPE-409 — short-lived download slots for inbound-email attachments.
 *
 * The exposure this closes: everything ever emailed to the site sits under
 * `cdn.meetmeatthefair.com/inbound-attachments/`, fetchable by anyone holding
 * the URL — raw camera originals with GPS intact, and third-party PDFs. The
 * keys never expire and cannot be revoked.
 *
 * John's condition on closing it, verbatim: *"Don't block until you have a way
 * to access. It is only the public that should be blocked, not you."* So the
 * public prefix cannot go away until agents can still read those bytes.
 *
 * ── Why a slot rather than a bigger inline cap ────────────────────────────
 *
 * `fetch_inbound_attachment` returns base64 inside an MCP tool result and caps
 * at 1.5 MB. Measured across the archive, **52 of 88 attachments (59%) are over
 * that cap**, including all five of this ticket's reference-case photos
 * (3.67–5.49 MB). So the recovery path returns `{ok: true, inlined: false}` for
 * the majority of the thing it exists to recover — a refusal that reports
 * success.
 *
 * Raising the cap is the wrong fix and it is worth saying why, because it is
 * the obvious one. Base64 inflates by 4/3 and the result is read into a MODEL'S
 * CONTEXT: a 7 MB object becomes a ~9.3 MB string that no context can hold. The
 * cap is not arbitrary, it is the honest limit of that transport. A URL moves
 * the bytes off the MCP channel entirely — the same reasoning K17 used to move
 * UPLOAD bytes off it (src/lib/upload-slot-token.ts), pointed the other way.
 *
 * ── Why KV, and why this mirrors the upload slot ──────────────────────────
 *
 * Same profile as K17's upload slots: minutes-long TTL, fire-and-forget, no
 * accounting. KV's native `expirationTtl` evicts without a sweep job and
 * without growing the D1 schema, and `RATE_LIMIT_KV` is already bound.
 *
 * ── Where it deliberately DIFFERS from the upload slot: not one-shot ──────
 *
 * `consumeUploadSlot` deletes on read. Copying that here would break the exact
 * workflow this is built for. The recovery flow is *fetch the object, then hand
 * the same URL to `upload_event_image`* — two reads of one URL. A one-shot
 * download token would fail the second one, and it would fail as a 404 that
 * reads like a missing attachment rather than like a spent token.
 *
 * So a slot is readable repeatedly until it expires, which is the ordinary
 * signed-URL model. The replay bound is the TTL, not a use count.
 *
 * ── Threat model ─────────────────────────────────────────────────────────
 *
 * - Issuance requires an admin session or `X-Internal-Key`; the token grants
 *   read of ONE attachment of ONE email, never a prefix or a bucket.
 * - 192 bits of `crypto.getRandomValues` entropy — not guessable.
 * - 10-minute TTL bounds a leak. Longer than the upload slot's 5 because the
 *   consumer is an agent that may fetch, inspect and re-upload in sequence;
 *   still short enough that a token quoted into a log or a ticket is inert
 *   long before anyone reads it. That permanence is the ticket's actual
 *   complaint about the CDN keys, so the fix must not reintroduce it.
 * - The token is the authorization: keep it out of server logs and never
 *   reflect it in an error body.
 */

const SLOT_TTL_SECONDS = 10 * 60;
const KV_PREFIX = "attachment-download:";
const TOKEN_BYTES = 24;

export interface AttachmentDownloadClaims {
  /** `inbound_emails.id` the attachment belongs to. */
  inboundEmailId: string;
  /** Index into that row's `attachment_refs`. */
  index: number;
  issuedAt: number;
  issuedBy: string;
}

export interface IssuedAttachmentDownload {
  token: string;
  expiresAt: Date;
  ttlSeconds: number;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Mint a slot for one attachment and store its claims in KV under a native TTL. */
export async function issueAttachmentDownloadSlot(
  kv: KVNamespace,
  args: { inboundEmailId: string; index: number; issuedBy: string }
): Promise<IssuedAttachmentDownload> {
  const raw = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(raw);
  const token = base64UrlEncode(raw);
  const issuedAt = Date.now();

  const claims: AttachmentDownloadClaims = {
    inboundEmailId: args.inboundEmailId,
    index: args.index,
    issuedAt,
    issuedBy: args.issuedBy,
  };

  await kv.put(KV_PREFIX + token, JSON.stringify(claims), {
    expirationTtl: SLOT_TTL_SECONDS,
  });

  return {
    token,
    expiresAt: new Date(issuedAt + SLOT_TTL_SECONDS * 1000),
    ttlSeconds: SLOT_TTL_SECONDS,
  };
}

/**
 * Resolve a slot WITHOUT consuming it — see the header note on why this is not
 * one-shot. Returns null for unknown, expired or corrupt tokens; the caller
 * answers 404 without echoing the token back.
 */
export async function resolveAttachmentDownloadSlot(
  kv: KVNamespace,
  token: string
): Promise<AttachmentDownloadClaims | null> {
  if (!token || token.length < 16 || token.length > 256) return null;

  const raw = await kv.get(KV_PREFIX + token, "text");
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<AttachmentDownloadClaims>;
    if (
      typeof parsed.inboundEmailId !== "string" ||
      parsed.inboundEmailId.length === 0 ||
      typeof parsed.index !== "number" ||
      !Number.isInteger(parsed.index) ||
      parsed.index < 0 ||
      typeof parsed.issuedAt !== "number" ||
      typeof parsed.issuedBy !== "string"
    ) {
      return null;
    }
    return parsed as AttachmentDownloadClaims;
  } catch {
    return null;
  }
}

/** Revoke a slot early — used when an issuing caller aborts. */
export async function revokeAttachmentDownloadSlot(kv: KVNamespace, token: string): Promise<void> {
  if (!token) return;
  await kv.delete(KV_PREFIX + token);
}

export const ATTACHMENT_DOWNLOAD_TTL_SECONDS = SLOT_TTL_SECONDS;
