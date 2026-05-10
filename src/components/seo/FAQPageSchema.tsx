import type { FaqItem } from "@/lib/event-faq";

// Emits Schema.org FAQPage JSON-LD. Pairs with `<EventFAQSection>` — both
// MUST receive the same `items` array so the JSON-LD matches visible
// content verbatim (Google's hard rule, see MMATF-FAQ-Strategy.md §8).

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
