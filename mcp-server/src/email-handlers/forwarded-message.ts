/**
 * OPE-944 — tell the FORWARDER's authentication apart from the ORIGINAL
 * sender's, and recover the message that a "Forward as attachment" carries.
 *
 * ## The problem this exists for
 *
 * Much of our best organizer data reaches submit@ second-hand. On inbound
 * `9fc287ef`, Carolyn (`shpandabear10@gmail.com`) forwarded the Town of New
 * Gloucester's vendor packet; it drove hours, attendance, a no-pets rule and a
 * 59-vendor roster onto a live page. The stored verdict for that message reads
 * `dkim=pass header.d=gmail.com`, `dmarc=pass`, `sender_auth: partial` — all
 * true, and all about CAROLYN'S GMAIL. The
 * `From: Sarah Rodriguez <recdirector@newgloucester.com>` line inside it is
 * body text that anyone could type.
 *
 * A reader of `get_inbound_email` sees a pass and can easily attribute it to
 * the organizer. That is the defect: not a missing check, but a verdict that
 * answers a question nobody asked.
 *
 * ## The two forward shapes, MEASURED (not assumed)
 *
 * Probed against postal-mime 2.7.4, the version in this repo:
 *
 * | shape | `attachments[]` | inner body in `.text` |
 * |---|---|---|
 * | `Content-Disposition: attachment` — Gmail "Forward as attachment" | the `message/rfc822` part ONLY | ❌ |
 * | no `Content-Disposition` on the rfc822 part | nested parts already hoisted | ✅ |
 *
 * So postal-mime ALREADY does what we want (parse the submessage, merge its
 * text, hoist its attachments — `postal-mime.js:205-207`) — but only when it
 * decides the part is `inline`, and an explicit `Content-Disposition:
 * attachment` header overrides the `rfc822Attachments` option. The one shape
 * that carries the organizer's intact DKIM signature is exactly the shape it
 * declines to open.
 *
 * ⚠️ This CORRECTS the filing ticket, which said the nested PDFs and body are
 * lost for `message/rfc822` generally. They are lost for the attachment-
 * disposition shape; in the inline shape they already flow today.
 *
 * We must therefore open it ourselves — which is the right answer anyway,
 * because DKIM verification needs the raw bytes EXACTLY as received, and
 * anything postal-mime inlines has already been through a parser.
 *
 * ⚠️ REPORT-ONLY (OPE-944 STOP gate). Everything here records and displays.
 * Nothing may gate routing, sender trust, auto-publication or an outbound
 * reply without issue-level approval — OPE-765 and OPE-839 own those.
 */
import PostalMime from "postal-mime";
import { verifyDkim, type DkimResult, type TxtResolver } from "./dkim-verify.js";

/**
 * How much we can say about who really wrote the forwarded content.
 *
 * Six values, because the six situations have genuinely different meanings and
 * collapsing any pair of them loses the distinction that makes the field worth
 * storing.
 */
export type OriginalSenderAuth =
  /** A nested signature validated against the signing domain's published key. */
  | "verified"
  /** A nested signature was present and did NOT validate. */
  | "failed"
  /** The nested message carried no DKIM signature. Common; not suspicious. */
  | "no_signature"
  /** A nested signature could not be checked — DNS, or a retired selector. */
  | "key_unavailable"
  /**
   * The body looks like a forward, but no `message/rfc822` part came with it.
   *
   * The ONLY honest verdict for an inline forward: the quoted `From:` line is
   * prose, and nothing about it can be checked, ever. This value exists so the
   * outer pass can never be read as the organizer's.
   */
  | "unverifiable_inline_forward"
  /** Not a forward at all. The existing `sender_auth` already describes it. */
  | "not_forwarded";

export interface NestedMessage {
  /** The nested message's raw bytes, decoded as text. Unmodified. */
  raw: string;
  text: string | null;
  html: string | null;
  subject: string | null;
  /** Attachments carried INSIDE the forwarded message. */
  attachments: Array<{
    filename: string | null;
    mimeType: string;
    content: ArrayBuffer | Uint8Array | string;
    disposition?: "attachment" | "inline" | null;
    contentId?: string;
    related?: boolean;
  }>;
}

export interface ForwardAnalysis {
  kind: "rfc822_attachment" | "inline_forward" | "not_forwarded";
  originalSenderAddress: string | null;
  originalSenderAuth: OriginalSenderAuth;
  /**
   * Whether the signing domain aligned with the nested `From:`.
   * `null` when there was nothing to align (no signature, or no nested message).
   */
  originalSenderDomainAligned: boolean | null;
  /** Audit trail. Never used for control flow. */
  detail: string;
  nested: NestedMessage | null;
  dkim: DkimResult | null;
}

/** A minimal attachment shape — matches postal-mime's, kept local for tests. */
export interface ForwardCandidateAttachment {
  filename: string | null;
  mimeType: string;
  content: ArrayBuffer | Uint8Array | string;
  disposition?: "attachment" | "inline" | null;
  contentId?: string;
  related?: boolean;
}

/**
 * Is this part a forwarded message?
 *
 * Two spellings, because clients disagree. `message/rfc822` is the correct one;
 * a `.eml` sent as `application/octet-stream` is what several clients (and any
 * drag-and-drop of a saved message) actually produce, and refusing it would
 * reintroduce the same silent drop under a different MIME type.
 */
export function isRfc822Attachment(a: { filename: string | null; mimeType: string }): boolean {
  const mime = (a.mimeType || "").toLowerCase().trim();
  if (mime === "message/rfc822") return true;
  const name = (a.filename || "").toLowerCase();
  return (
    (mime === "application/octet-stream" || mime === "application/eml" || mime === "") &&
    name.endsWith(".eml")
  );
}

function toText(content: ArrayBuffer | Uint8Array | string): string {
  if (typeof content === "string") return content;
  const u8 = content instanceof Uint8Array ? content : new Uint8Array(content);
  // Latin-1, not UTF-8, and deliberately: DKIM canonicalizes OCTETS. Decoding
  // as UTF-8 would replace any invalid sequence with U+FFFD and silently change
  // the bytes the body hash is computed over, turning a genuine signature into
  // a `failed` verdict. Latin-1 is the only single-byte round-trip decoding.
  return new TextDecoder("iso-8859-1").decode(u8);
}

/**
 * The `From:` address quoted inside an inline forward's preamble.
 *
 * Best-effort and explicitly untrustworthy — this is the string we are labelling
 * as unverifiable, so it is captured for the audit trail, never as evidence.
 * Scans only the first few lines after a forward delimiter so a `From:` quoted
 * far down in a reply chain is not mistaken for the forwarded sender.
 */
export function claimedInlineForwardSender(bodyText: string): string | null {
  const lines = bodyText.split(/\r?\n/);
  const DELIM = /^\s*(?:-{2,}\s*Forwarded message\s*-{2,}|Begin forwarded message:)\s*$/i;
  for (let i = 0; i < lines.length; i++) {
    if (!DELIM.test(lines[i])) continue;
    for (let k = i + 1; k < Math.min(i + 8, lines.length); k++) {
      const m = lines[k].match(/^\s*From\s*:\s*(.+)$/i);
      if (!m) continue;
      const angled = m[1].match(/<([^>]+)>/);
      const raw = angled ? angled[1] : m[1];
      const addr = raw.match(/[^\s<>@,;:"]+@[^\s<>@,;:"]+/);
      if (addr) return addr[0].toLowerCase();
    }
  }
  return null;
}

/** Does this body carry an inline forward preamble at all? */
export function looksLikeInlineForward(bodyText: string | null | undefined): boolean {
  if (!bodyText) return false;
  return /^\s*(?:-{2,}\s*Forwarded message\s*-{2,}|Begin forwarded message:)\s*$/im.test(bodyText);
}

/**
 * Classify a received message's forwarding, and recover the nested message when
 * one is genuinely attached.
 *
 * `resolveTxt` is injected so this is testable without DNS, and so a Worker can
 * pass a DoH-backed resolver. When it is omitted, DKIM is not attempted and a
 * present signature reports `key_unavailable` — which is the honest verdict for
 * "we could not check", and is why it is not silently `no_signature`.
 */
export async function analyzeForward(input: {
  attachments: ForwardCandidateAttachment[] | undefined;
  bodyText: string | null | undefined;
  resolveTxt?: TxtResolver;
}): Promise<ForwardAnalysis> {
  const rfc822 = (input.attachments ?? []).find((a) => isRfc822Attachment(a));

  // ── No attached message: either an inline forward, or not a forward. ──────
  if (!rfc822) {
    if (looksLikeInlineForward(input.bodyText)) {
      return {
        kind: "inline_forward",
        originalSenderAddress: claimedInlineForwardSender(input.bodyText ?? ""),
        originalSenderAuth: "unverifiable_inline_forward",
        originalSenderDomainAligned: null,
        detail:
          "forwarded inline; the quoted From: line is body text and carries no signature to check",
        nested: null,
        dkim: null,
      };
    }
    return {
      kind: "not_forwarded",
      originalSenderAddress: null,
      originalSenderAuth: "not_forwarded",
      originalSenderDomainAligned: null,
      detail: "no forwarded message found",
      nested: null,
      dkim: null,
    };
  }

  // ── An attached message. Open it OURSELVES, keeping the raw bytes. ────────
  const raw = toText(rfc822.content);
  let parsed: Awaited<ReturnType<typeof PostalMime.parse>> | null = null;
  try {
    parsed = await PostalMime.parse(raw);
  } catch {
    parsed = null;
  }

  const nested: NestedMessage = {
    raw,
    text: parsed?.text ?? null,
    html: parsed?.html ?? null,
    subject: parsed?.subject ?? null,
    attachments: (parsed?.attachments ?? []).map((a) => ({
      filename: a.filename,
      mimeType: a.mimeType,
      content: a.content,
      disposition: a.disposition,
      contentId: a.contentId,
      related: a.related,
    })),
  };

  // Prefer the PARSED From over anything quoted in prose.
  const parsedFrom = parsed?.from?.address?.toLowerCase() ?? null;

  if (!input.resolveTxt) {
    return {
      kind: "rfc822_attachment",
      originalSenderAddress: parsedFrom,
      originalSenderAuth: "key_unavailable",
      originalSenderDomainAligned: null,
      detail:
        "forwarded message recovered, but no DNS resolver was available to check its signature",
      nested,
      dkim: null,
    };
  }

  const dkim = await verifyDkim(raw, input.resolveTxt);
  return {
    kind: "rfc822_attachment",
    originalSenderAddress: dkim.fromAddress ?? parsedFrom,
    originalSenderAuth: dkim.verdict,
    // Alignment is only meaningful when a signature actually validated. A
    // `d=` on a signature that FAILED says nothing about who sent the message,
    // so reporting its alignment would dress an unverified claim as a finding.
    originalSenderDomainAligned: dkim.verdict === "verified" ? dkim.alignedWithFrom : null,
    detail: dkim.detail,
    nested,
    dkim,
  };
}
