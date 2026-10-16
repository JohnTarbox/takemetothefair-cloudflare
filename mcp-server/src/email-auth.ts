/**
 * Parse the inbound `Authentication-Results` header (RFC 8601) that Cloudflare
 * Email Routing attaches, to a coarse verdict used to gate the trusted-sender
 * fast-path (WS3e, 2026-06-11) and the photo auto-write (OPE-315 / OPE-254).
 *
 * WHY: the sender-trust tier is keyed on the From address, which is spoofable.
 * The "trusted" fast-path skips the spam/intent classifier, so a spoofed From
 * of a trusted sender would skip scrutiny. This verdict is what lets a trusted
 * From actually mean the trusted person.
 *
 * OPE-1369 closed two holes in the original parser:
 *   1. ONLY CLOUDFLARE'S OWN HEADER IS READ. `Headers.get` joins every
 *      Authentication-Results header in the message with ", ", and a sender can
 *      add as many as it likes. The old parser took the first `dkim=` anywhere
 *      in that joined string — and Cloudflare's header carries NO `dkim=` for
 *      unsigned mail — so a forged trailing `dkim=pass` became the verdict.
 *      Cloudflare's header is the FIRST of the joined list (true of every one
 *      of ~600 captured prod rows, 2026-10-15), and Cloudflare does NOT strip
 *      upstream headers claiming its authserv-id (Gmail-forwarded mail carries
 *      a second `mx.cloudflare.net` header from the forwarding hop). So the
 *      authserv-id alone is not enough: we take the first header, and only if
 *      its authserv-id is `mx.cloudflare.net`.
 *   2. "pass" MEANS AN ALIGNED DMARC PASS: `dmarc=pass header.from=<d>` where
 *      `<d>` is the From address's domain (when the caller supplies it). A bare
 *      SPF or DKIM pass proves only that SOME domain authenticated — anyone can
 *      get `spf=pass` for their own MAIL FROM.
 *
 * Verdicts:
 *   - "fail"    — DMARC failed, or SPF (MAIL FROM) failed with no DKIM pass.
 *   - "pass"    — aligned DMARC pass. The ONLY value that licenses trust.
 *   - "partial" — something authenticated and nothing failed, but no aligned
 *                 DMARC pass. Not trusted.
 *   - "unknown" — no Cloudflare header, or nothing recognisable. Not trusted.
 */
export type EmailAuthVerdict = "pass" | "partial" | "fail" | "unknown";

/** The authserv-id Cloudflare Email Routing stamps on its own header. */
export const CLOUDFLARE_AUTHSERV_ID = "mx.cloudflare.net";

/**
 * The first Authentication-Results header out of a `Headers.get`-joined value.
 *
 * Repeated headers are joined with ", ". A comma is not part of RFC 8601
 * resinfo grammar outside a comment or a quoted string, so the first top-level
 * comma is the boundary between the first header and the rest.
 */
export function firstAuthResultsHeader(joined: string): string {
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < joined.length; i++) {
    const c = joined[i];
    if (quoted) {
      if (c === "\\") i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "(") depth++;
    else if (c === ")" && depth > 0) depth--;
    else if (c === "," && depth === 0) return joined.slice(0, i);
  }
  return joined;
}

/**
 * Cloudflare's own header, lowercased — or null when the first header is not
 * Cloudflare's. Nothing after the first header is ever consulted: everything
 * there is sender-controlled.
 */
function cloudflareHeader(headerRaw: string | null | undefined): string | null {
  if (!headerRaw) return null;
  const first = firstAuthResultsHeader(headerRaw.toLowerCase()).trim();
  const authserv = first.split(";")[0].trim().split(/\s+/)[0];
  return authserv === CLOUDFLARE_AUTHSERV_ID ? first : null;
}

function methodResult(header: string, method: string): string | null {
  // Matches e.g. `spf=pass`, `dkim=fail`, `dmarc=none`. The lookbehind keeps
  // `policy.dmarc=none` from being read as the DMARC result.
  const m = header.match(new RegExp(`(?<![.\\w])${method}=([a-z]+)`));
  return m ? m[1] : null;
}

/** The `header.from` domain on the `dmarc=pass` clause, or null. */
function dmarcPassFromDomain(header: string): string | null {
  for (const clause of header.replace(/\([^()]*\)/g, "").split(";")) {
    if (!/(?<![.\w])dmarc=pass\b/.test(clause)) continue;
    const m = clause.match(/\bheader\.from=([a-z0-9.-]+)/);
    return m ? m[1].replace(/\.$/, "") : null;
  }
  return null;
}

function domainOf(addr: string | null | undefined): string | null {
  const a = (addr ?? "").trim().toLowerCase();
  const at = a.lastIndexOf("@");
  return at >= 0 && at < a.length - 1 ? a.slice(at + 1) : null;
}

/**
 * OPE-763 (review bounce) — the SPF result for the MAIL FROM identity.
 *
 * Cloudflare writes TWO `spf=` entries on ordinary Gmail mail: the HELO check
 * first (`spf=none … smtp.helo=mail-yx2-x11.google.com`), then the MAIL FROM
 * check (`spf=pass … smtp.mailfrom=jtarboxme@gmail.com`). Taking the first
 * match recorded `spf_result=none` for mail whose SPF actually passed. SPF's
 * identity is MAIL FROM (RFC 7208 §2.4); HELO is only the identity when MAIL
 * FROM is null.
 *
 * Prefers the entry whose properties name `smtp.mailfrom`; with none, falls
 * back to the first `spf=`. Parenthesised comments are stripped before
 * splitting on `;`, so a `;` inside one cannot move `smtp.mailfrom` into the
 * wrong clause.
 */
function spfResult(header: string): string | null {
  const clauses = header.replace(/\([^()]*\)/g, "").split(";");
  let first: string | null = null;
  for (const clause of clauses) {
    const m = clause.match(/\bspf=([a-z]+)/);
    if (!m) continue;
    if (/\bsmtp\.mailfrom=/.test(clause)) return m[1];
    first ??= m[1];
  }
  return first;
}

interface CfResults {
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
  /** `header.from` on the `dmarc=pass` clause; null when DMARC did not pass. */
  dmarcFrom: string | null;
}

function cfResults(header: string): CfResults {
  return {
    spf: spfResult(header),
    dkim: methodResult(header, "dkim"),
    dmarc: methodResult(header, "dmarc"),
    dmarcFrom: dmarcPassFromDomain(header),
  };
}

function isFail(r: CfResults): boolean {
  // DMARC is authoritative; an SPF hard-fail with no compensating DKIM pass
  // catches domains with no DMARC record, without over-blocking forwarded
  // mail (SPF fail + DKIM pass).
  return r.dmarc === "fail" || (r.spf === "fail" && r.dkim !== "pass");
}

/**
 * The gate verdict.
 *
 * `fromAddr` is the From address the trust tier was looked up by. When given,
 * the DMARC pass must be for THAT address's domain — an attacker's own domain
 * passing DMARC says nothing about a trusted From. Omitting it checks only
 * that the DMARC pass names a `header.from` at all.
 */
export function parseEmailAuth(
  headerRaw: string | null | undefined,
  fromAddr?: string | null
): EmailAuthVerdict {
  const header = cloudflareHeader(headerRaw);
  if (!header) return "unknown";
  const r = cfResults(header);

  if (isFail(r)) return "fail";

  if (r.dmarcFrom && (fromAddr === undefined || domainOf(fromAddr) === r.dmarcFrom)) {
    return "pass";
  }

  if (r.dmarc === "pass" || r.spf === "pass" || r.dkim === "pass") return "partial";
  return "unknown";
}

/**
 * OPE-763 — the same header, kept rather than collapsed.
 *
 * `parseEmailAuth` above condenses `Authentication-Results` to the verdict the
 * trusted-sender gate needs. That is right for a gate and wrong for a record:
 * John's framing — *"an email from a spammer in China … spoofing someone
 * else's email is of a far different caliber from an email from someone like
 * Jordan Sample, Assistant Division Director … CT DEEP"* — is a question about
 * a specific message, and answering it needs the individual method results.
 *
 * Since OPE-1369 the method results are read from Cloudflare's header ONLY (the
 * first header, authserv-id `mx.cloudflare.net`), exactly as the gate reads
 * them; `raw` still keeps the whole joined value for forensics.
 *
 * Record verdict (REPORT-ONLY — nothing routes on it): `pass` is the strict
 * "all three passed", `partial` is "something authenticated, nothing failed".
 * It is deliberately stricter than the gate's `pass` (a DMARC pass aligned via
 * DKIM alone is a gate `pass` but a record `partial`); the relationship between
 * the two is pinned by test.
 */
export type SenderAuthVerdict = "pass" | "partial" | "fail" | "unknown";

export interface EmailAuthDetail {
  /** The header verbatim, or null when the transport supplied none. */
  raw: string | null;
  /** Method results from Cloudflare's header, lowercased. Null when absent. */
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
  verdict: SenderAuthVerdict;
}

export function parseEmailAuthDetail(headerRaw: string | null | undefined): EmailAuthDetail {
  const raw = headerRaw ?? null;
  if (!raw) return { raw: null, spf: null, dkim: null, dmarc: null, verdict: "unknown" };

  const header = cloudflareHeader(raw);
  if (!header) return { raw, spf: null, dkim: null, dmarc: null, verdict: "unknown" };
  const r = cfResults(header);

  let verdict: SenderAuthVerdict;
  if (isFail(r)) {
    verdict = "fail";
  } else if (r.dmarc === "pass" && r.spf === "pass" && r.dkim === "pass") {
    verdict = "pass";
  } else if (r.dmarc === "pass" || r.spf === "pass" || r.dkim === "pass") {
    verdict = "partial";
  } else {
    verdict = "unknown";
  }

  return { raw, spf: r.spf, dkim: r.dkim, dmarc: r.dmarc, verdict };
}
