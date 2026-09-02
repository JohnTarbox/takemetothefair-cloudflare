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

/**
 * OPE-763 — the same header, kept rather than collapsed.
 *
 * `parseEmailAuth` above condenses `Authentication-Results` to the three
 * values the WS3e trusted-sender gate needs, uses it, and throws the rest
 * away. That was right for a gate and wrong for a record: John's framing —
 * *"an email from a spammer in China … spoofing someone else's email is of a
 * far different caliber from an email from someone like Jeremy Hall, Assistant
 * Division Director … CT DEEP"* — is a question about a specific message that
 * we could not answer, because the distinguishing bytes were read and
 * discarded in the same function call.
 *
 * ⚠️ `parseEmailAuth` IS DELIBERATELY UNTOUCHED. It gates a live path (the
 * trusted-sender fast-path), and the whole point of this ticket is capture:
 * an auth-parsing change that quietly altered routing is precisely the failure
 * OPE-763 scope 5 exists to prevent. The agreement between the two is asserted
 * by test rather than by construction, so this function is free to be more
 * expressive without the gate inheriting it.
 *
 * The fourth value, `partial`, is the one the 3-value verdict cannot express:
 * "something authenticated, but not everything, and nothing failed". A
 * mailing-list forward with `spf=fail dkim=pass` lands here, and so does a
 * plain `spf=pass` with no DKIM at all. Both are ordinary; neither is a clean
 * DMARC pass; and lumping them in with a full pass is what makes an audit
 * trail useless later.
 */
export type SenderAuthVerdict = "pass" | "partial" | "fail" | "unknown";

export interface EmailAuthDetail {
  /** The header verbatim, or null when the transport supplied none. */
  raw: string | null;
  /** Individual method results as reported, lowercased. Null when absent. */
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
  verdict: SenderAuthVerdict;
}

export function parseEmailAuthDetail(headerRaw: string | null | undefined): EmailAuthDetail {
  const raw = headerRaw ?? null;
  if (!raw) return { raw: null, spf: null, dkim: null, dmarc: null, verdict: "unknown" };

  const header = raw.toLowerCase();
  const spf = methodResult(header, "spf");
  const dkim = methodResult(header, "dkim");
  const dmarc = methodResult(header, "dmarc");

  // Failure first, and in the same order as `parseEmailAuth`, so the two can
  // never disagree about a spoof. DMARC is authoritative; an SPF hard-fail
  // with no compensating DKIM pass catches domains with no DMARC record.
  let verdict: SenderAuthVerdict;
  if (dmarc === "fail" || (spf === "fail" && dkim !== "pass")) {
    verdict = "fail";
  } else if (dmarc === "pass" && spf === "pass" && dkim === "pass") {
    verdict = "pass";
  } else if (dmarc === "pass" || spf === "pass" || dkim === "pass") {
    // At least one method authenticated and none failed authoritatively.
    verdict = "partial";
  } else {
    verdict = "unknown";
  }

  return { raw, spf, dkim, dmarc, verdict };
}

/**
 * The 4-value verdict collapsed to the 3-value one, for the equivalence test.
 *
 * Exported so the test asserts a relationship that is stated in code rather
 * than restated in the test — if this mapping ever stops being true, the
 * failure names the mapping instead of an opaque table of examples.
 */
export function collapseSenderAuth(v: SenderAuthVerdict): EmailAuthVerdict {
  return v === "partial" ? "pass" : v;
}
