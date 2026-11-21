/**
 * OPE-1598 — recognises scanner payloads posted to the problem-report form.
 *
 * Scanners post SQL fragments into every field they find. 48 of the 56 open
 * reports on 2026-11-09 were those payloads. The patterns below need a SQL or
 * script construct, not a keyword, so an honest report that says "the Union
 * Fair page won't let me select a date" stays a report.
 */
const PROBE_PATTERNS: RegExp[] = [
  /\bUNION\s+(ALL\s+)?SELECT\b/,
  /\bEXTRACTVALUE\s*\(/,
  /\bUPDATEXML\s*\(/,
  /\bORDER\s+BY\s+\d+\s*(--|#|$)/,
  /\b(AND|OR)\s*\(*\s*\d+\s*=\s*\d+/,
  /\bSLEEP\s*\(\s*\d+\s*\)/,
  /\bWAITFOR\s+DELAY\b/,
  /\bBENCHMARK\s*\(\s*\d+/,
  /\bINFORMATION_SCHEMA\b/,
  /<\s*SCRIPT\b/,
  /<[^>]+\bON(ERROR|LOAD)\s*=/,
  /\bJAVASCRIPT\s*:/,
];

/** Scanners split keywords with empty SQL comments and MySQL version comments. */
function normalise(body: string): string {
  return body
    .replace(/\/\*!\d*/g, " ")
    .replace(/\/\*.*?\*\//g, " ")
    .replace(/\*\//g, " ")
    .toUpperCase();
}

export function isInjectionProbe(body: string): boolean {
  const text = normalise(body);
  return PROBE_PATTERNS.some((pattern) => pattern.test(text));
}
