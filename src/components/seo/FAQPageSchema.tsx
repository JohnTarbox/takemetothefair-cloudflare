import type { FaqItem } from "@/lib/event-faq";

/**
 * Emits a Schema.org FAQPage JSON-LD `<script>` block. Renders `null` when
 * `items` is empty (no schema is better than empty schema for Google).
 *
 * This component is source-agnostic — selecting which items to pass is the
 * caller's job. The two callers in this repo are:
 *
 *   1. `src/app/events/[slug]/page.tsx` — passes `buildEventFaqItems(...)`.
 *      The HTML twin is `<EventFAQSection>`; both MUST receive the same
 *      array so the JSON-LD matches visible content verbatim (Google's hard
 *      rule, MMATF-FAQ-Strategy.md §8).
 *
 *   2. `src/app/blog/[slug]/page.tsx` — selects between two sources at
 *      render time:
 *        Tier 1 (wins): `blog_posts.faqs` JSON column when it has
 *                       ≥ FAQ_MIN_ITEMS (=3) valid {question, answer} pairs.
 *        Tier 2 (fallback): `extractBlogFaqItems(post.body)` parses
 *                           `## Q: …` H2 headings. Used only when Tier 1
 *                           doesn't meet the threshold.
 *      The two sources never combine; one wins per render, or neither
 *      meets the threshold and no FAQPage is emitted.
 *
 * Changing the precedence rule requires updating both `blog/[slug]/page.tsx`
 * and the CLAUDE.md "Blog FAQ schema" section.
 */

interface FAQPageSchemaProps {
  items: FaqItem[];
}

export function FAQPageSchema({ items }: FAQPageSchemaProps) {
  if (items.length === 0) return null;

  const schema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer,
      },
    })),
  };

  // Strip undefined fields, matching the EventSchema pattern.
  const cleanSchema = JSON.parse(JSON.stringify(schema));
  const html = JSON.stringify(cleanSchema);

  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: html }} />;
}
