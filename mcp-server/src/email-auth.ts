/**
 * Parse the inbound `Authentication-Results` header (RFC 8601) that Cloudflare
 * Email Routing attaches, to a coarse verdict used to gate the trusted-sender
 * fast-path (WS3e, 2026-06-11).
 *
 * WHY: the sender-trust tier is keyed on the From address, which is spoofable.
 * The "trusted" fast-path skips the spam/intent classifier, so a spoofed From
 * of a trusted sender (whose domain lacks a strict DMARC policy, so Cloudflare
 * forwards it rather than rejecting) would skip scrutiny. This lets the handler
 * downgrade the fast-path when the message DEMONSTRABLY failed authentication.
 *
 * Verdict semantics (deliberately conservative — fail-open on "unknown"):
 *   - "fail"    — DMARC failed (authoritative alignment failure → spoof), or
 *                 SPF failed with no passing DKIM. Downgrade the fast-path.
 *   - "pass"    — DMARC passed, or SPF/DKIM passed. Honor trust.
 *   - "unknown" — header absent or no recognizable result. Do NOT downgrade
 *                 (we can't prove a spoof; preserve existing behavior). The
 *                 handler logs these so prod can confirm header presence before
 *                 tightening the gate to require "pass".
 */
export type EmailAuthVerdict = "pass" | "fail" | "unknown";

function methodResult(header: string, method: string): string | null {
  // Matches e.g. `spf=pass`, `dkim=fail`, `dmarc=none`. `Headers.get` already
  // joined any repeated headers with ", "; a word-boundary + method= is enough.
  const m = header.match(new RegExp(`\\b${method}=([a-z]+)`));
  return m ? m[1] : null;
}

export function parseEmailAuth(headerRaw: string | null | undefined): EmailAuthVerdict {
  if (!headerRaw) return "unknown";
  const header = headerRaw.toLowerCase();

  const spf = methodResult(header, "spf");
  const dkim = methodResult(header, "dkim");
  const dmarc = methodResult(header, "dmarc");

  // DMARC is authoritative: a fail means the From domain's alignment failed —
  // the canonical spoof signal. Also fail when SPF hard-fails with no DKIM
  // pass (catches spoofing of domains without a DMARC record), while NOT
  // over-blocking legitimately-forwarded mail (SPF fail + DKIM pass).
  if (dmarc === "fail") return "fail";
  if (spf === "fail" && dkim !== "pass") return "fail";

  if (dmarc === "pass" || spf === "pass" || dkim === "pass") return "pass";

  return "unknown";
}
