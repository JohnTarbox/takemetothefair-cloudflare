/**
 * OPE-457 — a body that is nothing but a URL is not prose.
 *
 * Email "MV 2" (submit@, 2026-08-17T23:52:41Z) had exactly one line of body:
 *
 *     https://vineyardartisans.com/
 *
 * No dates, no venue, no event names. The pipeline created **three** events —
 * "Vineyard Artisans Summer Festival" 2024-06-15, "…Holiday Festival"
 * 2024-12-07, "…Festivals" 2024-06-15 — and wrote citations attributing those
 * dates to `email://jtarboxme@gmail.com`, "Email body".
 *
 * ── Why that happened ─────────────────────────────────────────────────────
 *
 * The multi-source fan-out builds its source list as:
 *
 *     bodyHasSubstance = stripSignature(bodyTextRaw).trim().length > 20
 *     if (bodyHasSubstance && bodyUrls.length >= 1)
 *       sources = [ ...urls.map(url), { kind: "body" } ]
 *
 * `"https://vineyardartisans.com/\n\n"` trims to **29 characters**, clears the
 * 20-char bar, and the bare URL is handed to the LLM as an independent prose
 * source. There is nothing in it to extract, so the model supplied three
 * plausible-looking festivals instead.
 *
 * The URL itself was already a separate `kind: "url"` source in the same list,
 * so body-extracting it adds **no reachable information** — only hallucination
 * surface. That asymmetry is what makes this safe to cut: we are not trading
 * recall for precision, we are deleting a source that could never contribute.
 *
 * ── Note on the original diagnosis ────────────────────────────────────────
 *
 * OPE-457 read this as a provenance-threading bug — "the pipeline knows the URL
 * and discards it at citation-write time". Checked against the code and prod:
 * `sourceIdentity()` already carries the fetched URL for `kind: "url"` sources,
 * and all four events have `source_url = NULL`, which only happens on the BODY
 * path. So the citations are not misattributing a scraped value; the body
 * source genuinely produced them. The attribution is accurate — what it is
 * accurately attributing is a fabrication.
 *
 * That makes this the more serious reading, not the lesser one: the provenance
 * layer was working, and it faithfully recorded an invented fact.
 */

/** URLs, in the forms that appear in a plain-text email body. */
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()[\]{}"']+/gi;

/** Bare angle-bracket wrappers Gmail leaves around inline links. */
const BRACKET_URL_RE = /<\s*(?:https?:\/\/|www\.)[^>]*>/gi;

/**
 * The prose left once URLs are removed. Exported for tests and so a caller can
 * log what it actually measured rather than a bare boolean.
 */
export function proseRemainder(body: string): string {
  if (!body) return "";
  return (
    body
      .replace(BRACKET_URL_RE, " ")
      .replace(URL_RE, " ")
      // Citation scaffolding like "[1", "2," left behind by link-footnote styles.
      .replace(/\[\s*\d+\s*\]?/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * True when the body carries prose worth running an extractor over, once
 * signature and URLs are discounted.
 *
 * `stripSignature` stays the caller's job — it already runs upstream and needs
 * the raw body; this only removes what the URL sources already cover.
 *
 * The 20-character threshold is unchanged from the original
 * `bodyHasSubstance`; the fix is WHAT is measured, not how much of it.
 */
export function bodyHasProseSubstance(signatureStrippedBody: string): boolean {
  return proseRemainder(signatureStrippedBody).length > 20;
}
