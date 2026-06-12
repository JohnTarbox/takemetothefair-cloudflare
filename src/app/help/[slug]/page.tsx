import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MarkdownContent } from "@/components/blog/markdown-content";
import { BreadcrumbSchema } from "@/components/seo/BreadcrumbSchema";
import { WebPageSchema } from "@/components/seo/WebPageSchema";
import { HELP_ARTICLES, getHelpArticle } from "@/lib/help-articles";

export const revalidate = 86400;

interface Props {
  params: Promise<{ slug: string }>;
}

// Pre-render every help article at build time (the registry is static).
export function generateStaticParams() {
  return HELP_ARTICLES.map((a) => ({ slug: a.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const article = getHelpArticle(slug);
  if (!article) {
    return { title: "Help | Meet Me at the Fair" };
  }
  const url = `https://meetmeatthefair.com/help/${article.slug}`;
  const title = `${article.title} | Meet Me at the Fair`;
  return {
    title,
    description: article.description,
    alternates: { canonical: url },
    openGraph: {
      title,
      description: article.description,
      url,
      siteName: "Meet Me at the Fair",
      type: "article",
      images: ["https://meetmeatthefair.com/og-default.png"],
    },
  };
}

export default async function HelpArticlePage({ params }: Props) {
  const { slug } = await params;
  const article = getHelpArticle(slug);
  if (!article) {
    notFound();
  }

  const url = `https://meetmeatthefair.com/help/${article.slug}`;

  return (
    <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-12">
      <BreadcrumbSchema
        items={[
          { name: "Home", url: "https://meetmeatthefair.com" },
          { name: "Help", url: "https://meetmeatthefair.com/help" },
          { name: article.title, url },
        ]}
      />
      <WebPageSchema
        name={`${article.title} | Meet Me at the Fair`}
        description={article.description}
        url={url}
      />

      <nav className="mb-6 text-sm text-muted-foreground">
        <Link href="/help" className="text-royal underline hover:text-royal/80">
          Help
        </Link>
        <span className="mx-2">/</span>
        <span>{article.title}</span>
      </nav>

      <h1 className="text-4xl font-bold text-foreground mb-3">{article.title}</h1>
      <p className="text-lg text-muted-foreground mb-8">{article.description}</p>

      <MarkdownContent content={article.body} />
    </div>
  );
}
