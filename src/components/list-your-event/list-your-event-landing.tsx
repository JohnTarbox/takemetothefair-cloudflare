import Link from "next/link";
import { ListEventForm } from "@/app/list-your-event/list-event-form";
import { FAQPageSchema } from "@/components/seo/FAQPageSchema";
import { LIST_YOUR_EVENT_FAQ } from "@/lib/list-your-event/landing-content";

/**
 * OPE-1558 form + OPE-1559 landing: shared by /list-your-event and the six
 * /list-your-event/[state] pages. The visible FAQ and the FAQPage JSON-LD are
 * rendered from the SAME array, so they match verbatim.
 */
export function ListYourEventLanding({
  stateName,
  stateCode,
}: {
  stateName?: string;
  stateCode?: string;
}) {
  const faq = [...LIST_YOUR_EVENT_FAQ];
  return (
    <main className="mx-auto max-w-xl px-4 py-8 sm:py-12">
      <FAQPageSchema items={faq} />
      <h1 className="text-2xl font-bold text-foreground sm:text-3xl">
        List your event free{stateName ? ` in ${stateName}` : ""}
      </h1>
      <p className="mt-2 text-foreground">
        Fairs, festivals, craft shows, school and church fairs — if it&apos;s in New England and
        open to the public, it belongs here. Fill in what you know; we&apos;ll do the rest.
      </p>
      <div className="mt-6">
        <ListEventForm defaultState={stateCode} />
      </div>
      <p className="mt-8 text-sm text-muted-foreground">
        Have a web page for it? You can also{" "}
        <Link href="/suggest-event" className="text-royal hover:underline">
          paste a link
        </Link>{" "}
        and we&apos;ll fill the details in from the page.
      </p>

      <section className="mt-10 border-t border-border pt-8" aria-labelledby="list-faq-heading">
        <h2 id="list-faq-heading" className="text-xl font-bold text-foreground">
          Questions
        </h2>
        <dl className="mt-4 space-y-4">
          {faq.map((item) => (
            <div key={item.question}>
              <dt className="font-semibold text-foreground">{item.question}</dt>
              <dd className="mt-1 text-muted-foreground">{item.answer}</dd>
            </div>
          ))}
        </dl>
      </section>
    </main>
  );
}
