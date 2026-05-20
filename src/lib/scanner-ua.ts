/**
 * Known email-scanner User-Agent patterns. Mirror of the same list in
 * mcp-server/src/intent-fastpath.ts (KNOWN_SCANNER_UA_PATTERNS).
 *
 * Why two copies: the main app and the MCP worker are separate
 * deployments; sharing a workspace package for ten regexes is overkill.
 * When a new scanner UA shows up in production, add it to BOTH files
 * — search for "KNOWN_SCANNER_UA_PATTERNS" and update the mirror.
 *
 * Used by /feedback/[token] (this app) to consume scanner pre-clicks
 * without writing a sender_feedback row (spec §Q8).
 */

const KNOWN_SCANNER_UA_PATTERNS: RegExp[] = [
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

export function isKnownScannerUaServer(ua: string): boolean {
  if (!ua) return false;
  return KNOWN_SCANNER_UA_PATTERNS.some((re) => re.test(ua));
}
