/**
 * OPE-456 scope 1b — never auto-answer a machine-generated notification that
 * arrived inside a FORWARD.
 *
 * `isNonActionableSender` already blocks `noreply@`-style senders, but it reads
 * the ENVELOPE from-address. When a human forwards a machine notification to
 * `submit@`, the envelope sender is the human, so the guard sees an ordinary
 * person and the mail runs the full event-submission pipeline.
 *
 * The specimen: Google Search Console mailed `sc-noreply@google.com` →
 * "Congrats on reaching 12K clicks in 28 days!", John forwarded it to submit@,
 * and the pipeline replied *"We couldn't find a link to the event in your
 * message"* — copy about fair websites and ticket pages, in answer to Search
 * Console. The milestone itself ingested correctly; the demux additionally
 * handed the same mail to the submission lane. One email, two consumers, one of
 * them wrong.
 *
 * ── Why this suppresses the REPLY and not the processing ─────────────────
 *
 * A forwarded machine notification often carries something we DO want — the
 * milestone row in this case. Dropping the message at the door would trade a
 * wrong reply for a lost signal. What is never right is answering it: the
 * original sender is a no-reply robot, and the forwarder already knows what
 * they sent. Silence is the correct output.
 *
 * ── Why the ORIGINAL sender and not just keywords ────────────────────────
 *
 * Matching on subject shape ("Congrats on reaching…") would be brittle and
 * would misfire on a human writing about a milestone. The load-bearing fact is
 * that the mail a human forwarded was itself sent by a machine that cannot
 * receive a reply, and that is stated in the forwarded header block.
 */
import { NON_ACTIONABLE_LOCALPARTS } from "./audit-sender.js";

/**
 * A forwarded-header `From:` line, in the shapes mail clients actually emit:
 *
 *   From: Google Search Console <sc-noreply@google.com>
 *   From: sc-noreply@google.com
 *   > From: "Search Console" <sc-noreply@google.com>
 *
 * Anchored to the start of a line (after optional quote markers) so a mention
 * of an address in prose does not count as a forwarded header.
 */
const FORWARDED_FROM_RE = /^[ \t>]*From:[ \t]*(?:[^<\n]*<)?([^\s<>@]+@[^\s<>]+?)>?[ \t]*$/gim;

export interface ForwardedMachineNotification {
  /** True when the forwarded original was sent by a no-reply style sender. */
  isMachine: boolean;
  /** The offending original sender, for the log line. Null when none matched. */
  originalSender: string | null;
}

/** `sc-noreply` matches `noreply` only as a dash/dot-delimited token, so a real
 *  person at `noreplyfan@x.com` is not caught — the same rule audit-sender uses,
 *  extended to cover a vendor-prefixed robot like `sc-noreply`. */
function isMachineAddress(addr: string): boolean {
  const at = addr.lastIndexOf("@");
  if (at <= 0) return false;
  const local = addr.slice(0, at).toLowerCase();
  return NON_ACTIONABLE_LOCALPARTS.some(
    (needle) =>
      local === needle ||
      local.startsWith(`${needle}-`) ||
      local.startsWith(`${needle}.`) ||
      local.endsWith(`-${needle}`) ||
      local.endsWith(`.${needle}`)
  );
}

/**
 * Inspect a body for a forwarded machine-sent original.
 *
 * Pure and deterministic. Returns the first machine sender found in a
 * forwarded `From:` header, or `{ isMachine: false }`.
 */
export function detectForwardedMachineNotification(
  bodyText: string | null | undefined
): ForwardedMachineNotification {
  if (!bodyText) return { isMachine: false, originalSender: null };
  for (const m of bodyText.matchAll(FORWARDED_FROM_RE)) {
    const addr = m[1];
    if (addr && isMachineAddress(addr)) {
      return { isMachine: true, originalSender: addr.toLowerCase() };
    }
  }
  return { isMachine: false, originalSender: null };
}
