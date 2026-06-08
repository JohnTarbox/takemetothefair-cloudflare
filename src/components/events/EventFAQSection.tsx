import { HelpCircle } from "lucide-react";
import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { FAQ_MIN_ITEMS, type FaqItem } from "@/lib/event-faq";

// Visible FAQ section for event detail pages. Pairs with `<FAQPageSchema>`
// (JSON-LD emitter) — both consume the same `items` array so visible
// content matches structured data verbatim (Google's hard rule, see
// MMATF-FAQ-Strategy.md §8).
//
// Suppression: returns null when fewer than FAQ_MIN_ITEMS (=3) items are
// present. A 1-2 question FAQ looks abandoned; the schema doc says omit.
//
// Accessibility / no-JS: uses native <details>/<summary> so the accordion
// works without client-side JavaScript and is announced correctly by
// screen readers as a disclosure widget.

interface EventFAQSectionProps {
  items: FaqItem[];
}

export function EventFAQSection({ items }: EventFAQSectionProps) {
  if (items.length < FAQ_MIN_ITEMS) return null;

  return (
    <Card>
      <CardHeader>
        <h2
          id="event-faq-heading"
          className="text-xl font-semibold text-foreground flex items-center gap-2"
        >
          <HelpCircle className="w-5 h-5" />
          Frequently Asked Questions
        </h2>
      </CardHeader>
      <CardContent>
        <section aria-labelledby="event-faq-heading" className="divide-y divide-gray-100 -mx-2">
          {items.map((item, i) => (
            <details key={i} className="group py-3 px-2 [&_summary::-webkit-details-marker]:hidden">
              <summary className="flex cursor-pointer items-start justify-between gap-3 text-sm font-medium text-foreground hover:text-royal">
                <span>{item.question}</span>
                <span
                  aria-hidden="true"
                  className="mt-0.5 text-muted-foreground transition-transform group-open:rotate-45 select-none"
                >
                  +
                </span>
              </summary>
              <p className="mt-2 text-sm text-foreground whitespace-pre-line">{item.answer}</p>
            </details>
          ))}
        </section>
      </CardContent>
    </Card>
  );
}
