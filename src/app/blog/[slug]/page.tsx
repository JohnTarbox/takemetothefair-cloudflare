import { notFound } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { Calendar, ArrowLeft, Tag, User, Pencil, Link2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { getCloudflareDb } from "@/lib/cloudflare";
import { blogPosts, users, events, venues } from "@/lib/db/schema";
import { eq, and, ne, desc, gte, or, like } from "drizzle-orm";
import { isPublicEventStatus } from "@/lib/event-status";
import { auth } from "@/lib/auth";
import { MarkdownContent } from "@/components/blog/markdown-content";
import { ShareButtons } from "@/components/ShareButtons";
import { BreadcrumbSchema } from "@/components/seo/BreadcrumbSchema";
import { BlogPostCard } from "@/components/blog/blog-post-card";
import { BlogStatusButton } from "@/components/blog/blog-status-button";
import { ArticleSchema } from "@/components/seo/ArticleSchema";
import { FAQPageSchema } from "@/components/seo/FAQPageSchema";
import { extractBlogFaqItems } from "@/lib/blog-faq";
import { FAQ_MIN_ITEMS, type FaqItem } from "@/lib/event-faq";
import { formatDateLong, formatDateMedium } from "@/lib/datetime";
import {
  extractFirstImage,
  estimateReadingTime,
  countWords,
  extractHeadings,
} from "@/lib/markdown-utils";
import { formatAuthorName, unsafeSlug } from "@/lib/utils";
import { TableOfContents } from "@/components/blog/table-of-contents";
import { getEntitiesLinkedFromPost } from "@/lib/content-links-query";
import type { Metadata } from "next";
import { cdnImage, OG_EVENT } from "@/lib/cdn-image";

export const runtime = "edge";
export const revalidate = 300;

interface Props {
  params: Promise<{ slug: string }>;
}

async function getPost(slug: string) {
  const db = getCloudflareDb();
  const [post] = await db
    .select({
      id: blogPosts.id,
      title: blogPosts.title,
      slug: blogPosts.slug,
      body: blogPosts.body,
      excerpt: blogPosts.excerpt,
      authorId: blogPosts.authorId,
      authorName: users.name,
      tags: blogPosts.tags,
      categories: blogPosts.categories,
      faqs: blogPosts.faqs,
      featuredImageUrl: blogPosts.featuredImageUrl,
      status: blogPosts.status,
      publishDate: blogPosts.publishDate,
      metaTitle: blogPosts.metaTitle,
      metaDescription: blogPosts.metaDescription,
      createdAt: blogPosts.createdAt,
      updatedAt: blogPosts.updatedAt,
    })
    .from(blogPosts)
    .leftJoin(users, eq(blogPosts.authorId, users.id))
    .where(eq(blogPosts.slug, unsafeSlug(slug)))
    .limit(1);

  return post || null;
}

async function getRecentPosts(excludeId: string) {
  const db = getCloudflareDb();
  return db
    .select({
      id: blogPosts.id,
      title: blogPosts.title,
      slug: blogPosts.slug,
      body: blogPosts.body,
      excerpt: blogPosts.excerpt,
      authorName: users.name,
      tags: blogPosts.tags,
      categories: blogPosts.categories,
      featuredImageUrl: blogPosts.featuredImageUrl,
      status: blogPosts.status,
      publishDate: blogPosts.publishDate,
    })
    .from(blogPosts)
    .leftJoin(users, eq(blogPosts.authorId, users.id))
    .where(and(eq(blogPosts.status, "PUBLISHED"), ne(blogPosts.id, excludeId)))
    .orderBy(desc(blogPosts.publishDate))
    .limit(3);
}

async function getRelatedEvents(tags: string[], categories: string[]) {
  try {
    const db = getCloudflareDb();
    // Build search terms from tags and categories
    const searchTerms = [...tags, ...categories].filter(Boolean);
    if (searchTerms.length === 0) return [];

    // Match events whose name or categories overlap with blog tags
    const searchConditions = searchTerms.map((term) =>
      or(like(events.name, `%${term}%`), like(events.categories, `%${term}%`))
    );

    const results = await db
      .select({
        id: events.id,
        name: events.name,
        slug: events.slug,
        startDate: events.startDate,
        endDate: events.endDate,
        imageUrl: events.imageUrl,
        venueName: venues.name,
        venueCity: venues.city,
        venueState: venues.state,
      })
      .from(events)
      .leftJoin(venues, eq(events.venueId, venues.id))
      .where(and(isPublicEventStatus(), gte(events.endDate, new Date()), or(...searchConditions)))
      .orderBy(events.startDate)
      .limit(3);

    return results;
  } catch {
    return [];
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const post = await getPost(slug);

  if (!post) {
    return { title: "Post Not Found" };
  }

  const title = post.metaTitle || `${post.title} | Meet Me at the Fair`;
  const description = post.metaDescription || post.excerpt || post.title;
  const url = `https://meetmeatthefair.com/blog/${post.slug}`;

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title: post.title,
      description,
      url,
      siteName: "Meet Me at the Fair",
      type: "article",
      ...(post.publishDate && { publishedTime: new Date(post.publishDate).toISOString() }),
      // IMG1 (2026-06-07) — sized 1200×630 derivatives + format=auto so
      // social previews don't drag the full upload-pipeline master.
      images: [
        {
          url: cdnImage(
            post.featuredImageUrl || "https://meetmeatthefair.com/og-default.png",
            OG_EVENT
          ),
          width: 1200,
          height: 630,
          alt: post.title,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: post.title,
      description,
      images: [
        cdnImage(post.featuredImageUrl || "https://meetmeatthefair.com/og-default.png", OG_EVENT),
      ],
    },
  };
}

export default async function BlogPostPage({ params }: Props) {
  const { slug } = await params;
  const post = await getPost(slug);

  if (!post) {
    notFound();
  }

  const session = await auth();
  const isAdmin = session?.user?.role === "ADMIN";

  // Non-admins can only see published posts
  if (post.status !== "PUBLISHED" && !isAdmin) {
    notFound();
  }

  const tags = JSON.parse(post.tags || "[]") as string[];
  const categories = JSON.parse(post.categories || "[]") as string[];
  const readingTime = estimateReadingTime(post.body);
  const wordCount = countWords(post.body);
  const headings = extractHeadings(post.body);
  const postImage = post.featuredImageUrl || extractFirstImage(post.body);
  const [recentPosts, relatedEvents, linkedEntities] = await Promise.all([
    getRecentPosts(post.id),
    getRelatedEvents(tags, categories),
    getEntitiesLinkedFromPost(getCloudflareDb(), post.id),
  ]);
  const hasLinkedEntities =
    linkedEntities.events.length + linkedEntities.vendors.length + linkedEntities.venues.length > 0;
  const parsedRecentPosts = recentPosts.map((p) => ({
    ...p,
    authorName: formatAuthorName(p.authorName),
    tags: JSON.parse(p.tags || "[]") as string[],
    categories: JSON.parse(p.categories || "[]") as string[],
    featuredImageUrl: p.featuredImageUrl || extractFirstImage(p.body),
  }));

  const publishDate = post.publishDate ? formatDateLong(post.publishDate) : null;

  const url = `https://meetmeatthefair.com/blog/${post.slug}`;

  // FAQ source priority: explicit `faqs` column (MCP/admin-managed) wins
  // when it has >= FAQ_MIN_ITEMS pairs. Otherwise fall back to the original
  // Tier 2 extractor that parses `## Q: ...` H2 headings in the markdown
  // body (MMATF-FAQ-Strategy.md §4.2). Posts with neither emit no FAQ
  // schema — <FAQPageSchema> renders null for an empty array.
  const blogFaqItems: FaqItem[] = (() => {
    let parsed: unknown = [];
    try {
      parsed = JSON.parse(post.faqs || "[]");
    } catch {
      parsed = [];
    }
    if (
      Array.isArray(parsed) &&
      parsed.length >= FAQ_MIN_ITEMS &&
      parsed.every(
        (it): it is FaqItem =>
          typeof it === "object" &&
          it !== null &&
          typeof (it as FaqItem).question === "string" &&
          typeof (it as FaqItem).answer === "string"
      )
    ) {
      return parsed;
    }
    return extractBlogFaqItems(post.body);
  })();

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
      <BreadcrumbSchema
        items={[
          { name: "Home", url: "https://meetmeatthefair.com" },
          { name: "Blog", url: "https://meetmeatthefair.com/blog" },
          { name: post.title, url },
        ]}
      />

      <ArticleSchema
        headline={post.title}
        description={post.metaDescription || post.excerpt || post.title}
        datePublished={post.publishDate}
        dateModified={post.updatedAt}
        authorName={formatAuthorName(post.authorName)}
        image={postImage}
        url={url}
        wordCount={wordCount}
        readingTimeMinutes={readingTime}
        tags={tags}
        categories={categories}
      />

      <FAQPageSchema items={blogFaqItems} />

      {/* Back link */}
      <Link
        href="/blog"
        className="inline-flex items-center gap-1 text-sm text-royal hover:text-navy/80 mb-6"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Blog
      </Link>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Main content */}
        <article className="lg:col-span-2">
          {/* Status badge for admins */}
          {isAdmin && post.status === "DRAFT" && (
            <div className="mb-4">
              <Badge variant="warning">Draft — not visible to the public</Badge>
            </div>
          )}

          {/* Title */}
          <h1 className="text-3xl sm:text-4xl font-bold text-navy mb-4">{post.title}</h1>

          {/* Meta line */}
          <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground mb-6">
            {publishDate && (
              <span className="flex items-center gap-1.5">
                <Calendar className="w-4 h-4" />
                {publishDate}
              </span>
            )}
            {formatAuthorName(post.authorName) && (
              <span className="flex items-center gap-1.5">
                <User className="w-4 h-4" />
                {formatAuthorName(post.authorName)}
              </span>
            )}
            <span>{readingTime} min read</span>
          </div>

          {/* Featured image — skip if the same image already appears in the body */}
          {post.featuredImageUrl && !post.body.includes(post.featuredImageUrl) && (
            <div className="aspect-video relative rounded-lg overflow-hidden mb-8">
              <Image
                src={post.featuredImageUrl}
                alt={`Featured image for ${post.title}`}
                fill
                sizes="(max-width: 1024px) 100vw, 66vw"
                className="object-cover"
                priority
              />
            </div>
          )}

          {/* Markdown body */}
          <MarkdownContent content={post.body} />

          {/* Tags */}
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-8 pt-6 border-t border-border">
              {tags.map((tag) => (
                <Link
                  key={tag}
                  href={`/blog/tag/${encodeURIComponent(tag.toLowerCase().replace(/\s+/g, "-"))}`}
                  className="inline-flex items-center gap-1 text-sm px-3 py-1 bg-stone-100 text-stone-900 rounded-full hover:bg-stone-300 transition-colors"
                >
                  <Tag className="w-3 h-3" />
                  {tag}
                </Link>
              ))}
            </div>
          )}

          {/* Share */}
          <div className="mt-6 pt-6 border-t border-border">
            <ShareButtons url={url} title={post.title} description={post.excerpt || post.title} />
          </div>
        </article>

        {/* Sidebar */}
        <aside className="lg:col-span-1 space-y-6">
          {headings.length >= 3 && <TableOfContents headings={headings} />}
          {/* Admin actions */}
          {isAdmin && (
            <Card>
              <CardContent className="p-4 space-y-3">
                <h3 className="text-sm font-semibold text-navy flex items-center gap-1.5">
                  <Pencil className="w-4 h-4" />
                  Admin Actions
                </h3>
                <BlogStatusButton slug={post.slug} currentStatus={post.status} />
                <div className="text-xs text-muted-foreground space-y-1">
                  <p>
                    Status:{" "}
                    <Badge
                      variant={post.status === "PUBLISHED" ? "success" : "warning"}
                      className="ml-1"
                    >
                      {post.status}
                    </Badge>
                  </p>
                  <p>Slug: {post.slug}</p>
                  <p>Author ID: {post.authorId}</p>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Categories */}
          {categories.length > 0 && (
            <Card>
              <CardContent className="p-4">
                <h3 className="text-sm font-semibold text-navy mb-2">Categories</h3>
                <div className="flex flex-wrap gap-2">
                  {categories.map((cat) => (
                    <Badge key={cat} variant="default">
                      {cat}
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Mentioned in this post — reverse of content_links */}
          {hasLinkedEntities && (
            <Card>
              <CardContent className="p-4">
                <h3 className="text-sm font-semibold text-navy mb-3 flex items-center gap-1.5">
                  <Link2 className="w-4 h-4" />
                  Mentioned in this post
                </h3>
                {linkedEntities.events.length > 0 && (
                  <div className="mb-3">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1.5">
                      Events
                    </p>
                    <ul className="space-y-1">
                      {linkedEntities.events.map((e) => (
                        <li key={`e-${e.slug}`}>
                          <Link
                            href={`/events/${e.slug}`}
                            className="text-sm text-royal hover:text-navy hover:underline"
                          >
                            {e.name}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {linkedEntities.venues.length > 0 && (
                  <div className="mb-3">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1.5">
                      Venues
                    </p>
                    <ul className="space-y-1">
                      {linkedEntities.venues.map((v) => (
                        <li key={`vn-${v.slug}`}>
                          <Link
                            href={`/venues/${v.slug}`}
                            className="text-sm text-royal hover:text-navy hover:underline"
                          >
                            {v.name}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {linkedEntities.vendors.length > 0 && (
                  <div>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1.5">
                      Vendors
                    </p>
                    <ul className="space-y-1">
                      {linkedEntities.vendors.map((v) => (
                        <li key={`vd-${v.slug}`}>
                          <Link
                            href={`/vendors/${v.slug}`}
                            className="text-sm text-royal hover:text-navy hover:underline"
                          >
                            {v.name}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Post info */}
          <Card>
            <CardContent className="p-4 text-xs text-muted-foreground space-y-1">
              {post.createdAt && <p>Created: {formatDateMedium(post.createdAt)}</p>}
              {post.updatedAt && <p>Updated: {formatDateMedium(post.updatedAt)}</p>}
            </CardContent>
          </Card>
        </aside>
      </div>

      {/* Related Events */}
      {relatedEvents.length > 0 && (
        <section className="mt-12 pt-8 border-t border-border">
          <h2 className="text-2xl font-bold text-navy mb-6">Related Events</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {relatedEvents.map((event) => (
              <Link
                key={event.id}
                href={`/events/${event.slug}`}
                className="flex gap-4 p-4 bg-card rounded-lg border border-border hover:border-royal hover:shadow-sm transition-all group"
              >
                {event.imageUrl && (
                  <div className="w-16 h-16 rounded-lg overflow-hidden flex-shrink-0 relative">
                    <Image
                      src={event.imageUrl}
                      alt={event.name}
                      fill
                      sizes="64px"
                      className="object-cover"
                    />
                  </div>
                )}
                <div className="min-w-0">
                  <p className="font-medium text-foreground group-hover:text-navy line-clamp-1">
                    {event.name}
                  </p>
                  {event.startDate && (
                    <p className="text-xs text-muted-foreground mt-1">
                      {formatDateMedium(event.startDate)}
                    </p>
                  )}
                  {event.venueName && (
                    <p className="text-xs text-muted-foreground">
                      {event.venueName}
                      {event.venueCity ? `, ${event.venueCity}` : ""}
                      {event.venueState ? `, ${event.venueState}` : ""}
                    </p>
                  )}
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* Recent posts */}
      {parsedRecentPosts.length > 0 && (
        <section className="mt-12 pt-8 border-t border-border">
          <h2 className="text-2xl font-bold text-navy mb-6">More from the Blog</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {parsedRecentPosts.map((p) => (
              <BlogPostCard key={p.id} post={p} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
