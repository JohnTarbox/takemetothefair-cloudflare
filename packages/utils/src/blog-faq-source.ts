/**
 * Classifier for the source of a blog post's `FAQPage` JSON-LD emission.
 * Shared between the main app and the MCP server so both surfaces agree on
 * what's emitting (or not). The full rule lives in CLAUDE.md "Blog FAQ
 * schema"; see `src/app/blog/[slug]/page.tsx` for the actual rendering
 * path and `src/lib/blog-faq.ts` for the Tier-2 extractor.
 *
 * Returns one of:
 *   - "column"   — the `blog_posts.faqs` JSON column has ≥ BLOG_FAQ_MIN_ITEMS
 *                  valid {question, answer} pairs (Tier 1 wins).
 *   - "markdown" — the column doesn't qualify but the body has ≥
 *                  BLOG_FAQ_MIN_ITEMS `## Q: …` H2 headings (Tier 2).
 *   - "none"     — neither source qualifies; no FAQPage is emitted.
 *
 * The classifier only *detects* whether each source qualifies; it does not
 * extract the items. That keeps it free of the markdown-stripping dependency
 * the full Tier-2 extractor needs, so it can live in `packages/utils`.
 */

/** Minimum item count for either source to trigger FAQPage emission. */
export const BLOG_FAQ_MIN_ITEMS = 3;

/**
 * Count the `## Q: …` H2 headings in a markdown body, skipping lines inside
 * fenced code blocks. Mirrors the leading regex of `extractBlogFaqItems`
 * (`src/lib/blog-faq.ts`) — keep the two in sync if either changes.
 */
function countMarkdownQHeadings(body: string): number {
  let count = 0;
  let inFence = false;
  for (const raw of body.split("\n")) {
    const line = raw.trimEnd();
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^##\s+Q\s*:\s*.+/.test(line)) count++;
  }
  return count;
}

/** Tier-1 column-source check: ≥ BLOG_FAQ_MIN_ITEMS valid {q, a} pairs. */
function columnHasQualifyingFaqs(faqsJson: string | null | undefined): boolean {
  if (!faqsJson) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(faqsJson);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed) || parsed.length < BLOG_FAQ_MIN_ITEMS) return false;
  // Match the page's validation in src/app/blog/[slug]/page.tsx exactly —
  // just shape checks, no length requirement. Empty {question:"", answer:""}
  // pairs are excluded upstream by the MCP `blogFaqInputSchema` (.min(1)),
  // so the divergence between strict and loose is theoretical.
  return parsed.every(
    (it) =>
      typeof it === "object" &&
      it !== null &&
      typeof (it as { question?: unknown }).question === "string" &&
      typeof (it as { answer?: unknown }).answer === "string"
  );
}

export type BlogFaqSource = "column" | "markdown" | "none";

export function blogFaqSource(
  faqsJson: string | null | undefined,
  body: string | null | undefined
): BlogFaqSource {
  if (columnHasQualifyingFaqs(faqsJson)) return "column";
  if (body && countMarkdownQHeadings(body) >= BLOG_FAQ_MIN_ITEMS) return "markdown";
  return "none";
}
