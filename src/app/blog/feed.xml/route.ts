import { getCloudflareDb } from "@/lib/cloudflare";
import { blogPosts, users } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { stripMarkdown } from "@/lib/markdown-utils";

export const runtime = "edge";

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function GET() {
  const db = getCloudflareDb();
  const baseUrl = "https://meetmeatthefair.com";

  const posts = await db
    .select({
      title: blogPosts.title,
      slug: blogPosts.slug,
      body: blogPosts.body,
      excerpt: blogPosts.excerpt,
      publishDate: blogPosts.publishDate,
      authorName: users.name,
    })
    .from(blogPosts)
    .leftJoin(users, eq(blogPosts.authorId, users.id))
    .where(eq(blogPosts.status, "PUBLISHED"))
    .orderBy(desc(blogPosts.publishDate))
    .limit(50);

  const items = posts
    .map((post) => {
      const description = post.excerpt || stripMarkdown(post.body).slice(0, 500);
      const pubDate = post.publishDate
        ? new Date(post.publishDate).toUTCString()
        : new Date().toUTCString();

      return `    <item>
      <title>${escapeXml(post.title)}</title>
      <link>${baseUrl}/blog/${post.slug}</link>
      <guid isPermaLink="true">${baseUrl}/blog/${post.slug}</guid>
      <description>${escapeXml(description)}</description>
      <pubDate>${pubDate}</pubDate>${post.authorName ? `\n      <author>${escapeXml(post.authorName)}</author>` : ""}
    </item>`;
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Meet Me at the Fair — Blog</title>
    <link>${baseUrl}/blog</link>
    <description>Stories, tips, and news about fairs, festivals, and community events across New England.</description>
    <language>en-us</language>
    <atom:link href="${baseUrl}/blog/feed.xml" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
    },
  });
}
