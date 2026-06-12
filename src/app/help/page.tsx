import type { Metadata } from "next";
import Link from "next/link";
import { WebPageSchema } from "@/components/seo/WebPageSchema";
import { HELP_ARTICLES } from "@/lib/help-articles";

export const revalidate = 86400;

export const metadata: Metadata = {
  title: "Help | Meet Me at the Fair",
  description:
    "Help and guides for Meet Me at the Fair — including developer documentation for integrating with our event-data syndication system.",
  alternates: { canonical: "https://meetmeatthefair.com/help" },
  openGraph: {
    title: "Help | Meet Me at the Fair",
    description:
      "Help and guides for Meet Me at the Fair — including developer documentation for integrating with our event-data syndication system.",
    url: "https://meetmeatthefair.com/help",
    siteName: "Meet Me at the Fair",
    type: "website",
    images: ["https://meetmeatthefair.com/og-default.png"],
  },
};

export default function HelpPage() {
  // Group articles by category so the hub stays organized as more are added.
  const byCategory = HELP_ARTICLES.reduce<Record<string, typeof HELP_ARTICLES>>((acc, article) => {
    (acc[article.category] ??= []).push(article);
    return acc;
  }, {});

  return (
    <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-12">
      <WebPageSchema
        name="Help | Meet Me at the Fair"
        description="Help and guides for Meet Me at the Fair, including developer documentation for the event-data syndication system."
        url="https://meetmeatthefair.com/help"
      />

      <h1 className="text-4xl font-bold text-foreground mb-3">Help</h1>
      <p className="text-lg text-muted-foreground mb-10">
        Guides and documentation for using Meet Me at the Fair — for fairgoers, vendors, promoters,
        and developers.
      </p>

      {Object.entries(byCategory).map(([category, articles]) => (
        <section key={category} className="mb-10">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-4">
            {category}
          </h2>
          <ul className="grid gap-4 sm:grid-cols-2">
            {articles.map((article) => (
              <li key={article.slug}>
                <Link
                  href={`/help/${article.slug}`}
                  className="block h-full rounded-xl border border-border bg-card p-5 transition-colors hover:border-royal/50 hover:bg-muted"
                >
                  <h3 className="font-semibold text-foreground mb-1">{article.title}</h3>
                  <p className="text-xs font-medium text-royal mb-2">{article.audience}</p>
                  <p className="text-sm text-muted-foreground">{article.description}</p>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <p className="mt-12 text-sm text-muted-foreground">
        Can&apos;t find what you need?{" "}
        <Link href="/contact" className="text-royal underline hover:text-royal/80">
          Contact us
        </Link>
        .
      </p>
    </div>
  );
}
