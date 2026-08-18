/**
 * OPE-436 — classify what happened when we tried an outbound link.
 *
 * `ticket_url` and `application_url` are the primary conversion action on an
 * event page ("Get Tickets", "Apply as a Vendor") and nothing has ever checked
 * that they resolve. The specimen ran for ~7 months on our second-most-viewed
 * Martha's Vineyard page:
 *
 *     http://www.marthasvinveyardagriculturalsociety.org/
 *                        ^^^
 *
 * `marthasvin**v**eyard` — a transposed letter. Not a dead site: a domain that
 * has never existed. Every visitor who clicked "tickets" got a DNS failure.
 *
 * ── Why a taxonomy rather than a boolean ─────────────────────────────────
 *
 * "Is it up?" is the wrong question, and answering it would produce a checker
 * nobody trusts. Three distinctions carry real weight:
 *
 *  1. **DNS failure outranks 404.** A hostname that does not resolve is almost
 *     always a data-entry defect — a typo we introduced — whereas a 404 is
 *     usually organizer churn, which is their business and not a bug in our
 *     data. Same "broken link" symptom, completely different owner.
 *
 *  2. **TLS failure with working HTTP is NOT dead.** OPE-424 found Island Arts
 *     Association serving a self-signed cert on :443 while plain HTTP is fine.
 *     A checker that force-upgrades http→https and reports the TLS error would
 *     declare a perfectly reachable organizer site broken — a false positive
 *     aimed squarely at the small organizer-run sites that are our
 *     highest-trust source class.
 *
 *  3. **A permanent redirect is an UPDATE, not a death.** 301 to a live page
 *     means the organizer moved; the right response is to propose storing the
 *     new URL, not to raise an alarm.
 *
 * ── And why one failure raises nothing ───────────────────────────────────
 *
 * Transient timeouts are the normal weather of the open web. A single failure
 * is not rot, and a checker that alerts on one will be muted within a week —
 * at which point it is worse than no checker, because the silence now reads as
 * health. `shouldRaise` requires repetition.
 */

export type LinkVerdict =
  | "ok"
  | "permanent_redirect"
  | "tls_error_http_ok"
  | "http_404"
  | "http_5xx"
  | "http_other"
  | "dns_failure"
  | "timeout";

/** What a probe observed. Kept transport-agnostic so this is pure. */
export interface ProbeOutcome {
  /** Final HTTP status after following redirects, or null when none was reached. */
  status: number | null;
  /** Final URL after redirects, when it differs from the requested one. */
  finalUrl?: string | null;
  /** True when the hostname could not be resolved at all. */
  dnsFailed?: boolean;
  /** True when the TLS handshake failed. */
  tlsFailed?: boolean;
  /** True when a plain-HTTP attempt succeeded after HTTPS failed. */
  httpFallbackOk?: boolean;
  /** True when the request timed out. */
  timedOut?: boolean;
  /** True when the redirect chain ended on a 301/308. */
  permanentRedirect?: boolean;
}

export function classifyProbe(o: ProbeOutcome): LinkVerdict {
  // DNS first: it subsumes everything else and is the highest-signal outcome.
  if (o.dnsFailed) return "dns_failure";
  // TLS broken but the site answers over HTTP — reachable, just not securely.
  // Checked BEFORE the generic tls/timeout branches so the OPE-424 case can
  // never be reported as dead.
  if (o.tlsFailed && o.httpFallbackOk) return "tls_error_http_ok";
  if (o.timedOut) return "timeout";
  if (o.tlsFailed) return "http_other";
  if (o.status === null) return "http_other";
  if (o.permanentRedirect && o.status >= 200 && o.status < 400) return "permanent_redirect";
  if (o.status === 404 || o.status === 410) return "http_404";
  if (o.status >= 500) return "http_5xx";
  if (o.status >= 200 && o.status < 400) return "ok";
  return "http_other";
}

export type LinkSeverity = "ERROR" | "WARNING" | "NOTICE" | null;

/**
 * Severity for a verdict, or null when nothing should be recorded.
 *
 * `tls_error_http_ok` is a NOTICE, not an error: the link works for a visitor.
 * It is worth knowing (we may want to store the http:// form, and OPE-424 is
 * the policy question) but it is not rot.
 */
export function severityFor(v: LinkVerdict): LinkSeverity {
  switch (v) {
    case "dns_failure":
      return "ERROR"; // a hostname that cannot exist — our typo, our defect
    case "http_404":
    case "http_other":
      return "WARNING";
    case "http_5xx":
    case "timeout":
      return null; // transient by nature; only repetition promotes these
    case "permanent_redirect":
    case "tls_error_http_ok":
      return "NOTICE";
    case "ok":
      return null;
  }
}

/** Consecutive failures required before a verdict is worth reporting. */
export const MIN_CONSECUTIVE_FAILURES: Record<LinkVerdict, number> = {
  ok: Infinity,
  permanent_redirect: 1, // a 301 is stable information, not a flake
  tls_error_http_ok: 2,
  http_404: 2,
  http_other: 2,
  // A hostname that does not resolve is not a transient condition, but one DNS
  // blip during an outage is possible — two passes is cheap insurance on a
  // finding that accuses us of a typo.
  dns_failure: 2,
  http_5xx: 3, // servers have bad days
  timeout: 3,
};

/**
 * Should this verdict be raised, given how many consecutive times it has been
 * seen? A single failure is never rot.
 */
export function shouldRaise(v: LinkVerdict, consecutiveFailures: number): boolean {
  if (severityFor(v) === null && v !== "http_5xx" && v !== "timeout") return false;
  return consecutiveFailures >= MIN_CONSECUTIVE_FAILURES[v];
}
