/**
 * Cheap regex pre-check for the trusted-sender fast-path (spec §C.5).
 *
 * The fast-path skips the LLM classifier when the sender is in the
 * `trusted` tier (drizzle/0075 inbound_email_senders) AND the email shape
 * looks single-intent. Without the pre-check, even trusted senders write
 * multi-intent emails — John's own 2026-05-19 test email (source
 * suggestion + Facebook URL + Lilac Festival correction) is the canonical
 * fast-path bypass case.
 *
 * Cost: a handful of regex passes (~1ms typical). The pre-check is a pure
 * function so the unit tests in intent-fastpath.test.ts can pin its
 * behavior without faking the AI binding.
 */

/** Returns true when the email shape contains a fast-path bypass signal —
 *  caller should run the full classifier even for trusted senders. */
export function hasMultiIntentOrSpecialSignal(input: {
  bodyText: string;
  bodyHtml: string;
  inReplyToHeader: string | null;
  referencesHeader: string | null;
}): { trigger: boolean; reason: string } {
  // 1. Multi-URL signal: 2+ distinct hosts in either body source.
  const distinctHosts = countDistinctHosts(input.bodyText + "\n" + input.bodyHtml);
  if (distinctHosts >= 2) {
    return { trigger: true, reason: `multi-url:${distinctHosts}-hosts` };
  }

  const body = (input.bodyText || "").toLowerCase();

  // 2. Correction keywords. Loose set — false positives are fine because
  //    they just trigger the full classifier, which then sorts it out.
  if (
    /\b(wrong|incorrect|should be|the date(?: is)?|appears to be)\b/.test(body) ||
    /\b(this is wrong|that's wrong|fix(?: this)?|change the)\b/.test(body)
  ) {
    return { trigger: true, reason: "correction-keyword" };
  }

  // 3. Source-suggestion keywords.
  if (
    /\bi (?:discovered|found) (?:a |another |this |the )?(?:site|website|page|calendar|listing)\b/.test(
      body
    ) ||
    /\b(?:you should check|have you tried|here is a website|here's a website|new source)\b/.test(
      body
    )
  ) {
    return { trigger: true, reason: "source-suggestion-keyword" };
  }

  // 4. Claim-request keywords.
  if (
    /\b(?:i am the organizer|i run this event|my event|claim (?:my|this) listing|how do i claim)\b/.test(
      body
    )
  ) {
    return { trigger: true, reason: "claim-keyword" };
  }

  // 5. Reply chain detected — In-Reply-To or References mention our own
  //    Message-IDs (which look like `<...@meetmeatthefair.com>` or come
  //    out of our notify@/submit@ senders).
  if (isReplyToOurThread(input.inReplyToHeader, input.referencesHeader)) {
    return { trigger: true, reason: "reply-chain" };
  }

  return { trigger: false, reason: "none" };
}

/** Public: check whether headers indicate the email is a reply to one of
 *  our prior outbound messages. The In-Reply-To / References values are
 *  Message-IDs we minted for notify@/submit@ replies; both surfaces use
 *  `@meetmeatthefair.com` in the Message-ID local-part suffix. */
export function isReplyToOurThread(inReplyTo: string | null, references: string | null): boolean {
  const headers = [inReplyTo || "", references || ""].join(" ");
  return /@(?:[a-z0-9-]+\.)?meetmeatthefair\.com>/i.test(headers);
}

/** Count distinct URL hosts in a blob of text. Used for the multi-URL
 *  pre-check and reused by the multi-intent splitter in email-handler. */
export function countDistinctHosts(blob: string): number {
  const hosts = new Set<string>();
  for (const m of blob.matchAll(/https?:\/\/([^/\s"'<>)]+)/gi)) {
    const host = (m[1] || "").toLowerCase().replace(/^www\./, "");
    if (host) hosts.add(host);
  }
  return hosts.size;
}

/** Known-scanner user agents that pre-click links in emails. Used by D.3
 *  feedback endpoints to consume the token but skip writing a feedback
 *  row. Spec §Q8. Maintain this list as new scanners appear in prod. */
export const KNOWN_SCANNER_UA_PATTERNS: RegExp[] = [
  /microsoft.*safelinks/i,
  /\bo365linkscan\b/i,
  /\bmimecast\b/i,
  /\bproofpoint\b/i,
  /\bbarracuda\b/i,
  /\bfortimail\b/i,
  /\bsymantec\b/i,
  /\btrendmicro\b/i,
  /linkprotect/i,
  /urlscan\.io/i,
  /\bSlackBot-LinkExpanding\b/i,
];

/** True iff the given UA matches a known link-scanner pattern. */
export function isKnownScannerUa(ua: string): boolean {
  if (!ua) return false;
  return KNOWN_SCANNER_UA_PATTERNS.some((re) => re.test(ua));
}
