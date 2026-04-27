import { NextRequest, NextResponse } from "next/server";
import { getCloudflareDb } from "@/lib/cloudflare";
import { blogPosts, users } from "@/lib/db/schema";
import { isAuthorized, getAuthorizedSession } from "@/lib/api-auth";
import { blogPostCreateSchema, validateRequestBody } from "@/lib/validations";
import { findBrokenLinksInDb } from "@/lib/blog-links";
import { syncContentLinks } from "@/lib/content-links-sync";
import { createSlug, getSlugPrefixBounds, findUniqueSlug } from "@/lib/utils";
import { logError } from "@/lib/logger";
import { eq, and, or, gt, lt, desc, sql } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const db = getCloudflareDb();
  const admin = await isAuthorized(request);
  const url = new URL(request.url);

  const status = url.searchParams.get("status");
  const tag = url.searchParams.get("tag");
  const before = url.searchParams.get("before");
  const after = url.searchParams.get("after");
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "20", 10), 100);
  const offset = parseInt(url.searchParams.get("offset") || "0", 10);

  try {
    const conditions = [];

    // Non-admin users can only see published posts
    if (!admin) {
      conditions.push(eq(blogPosts.status, "PUBLISHED"));
    } else if (status === "DRAFT" || status === "PUBLISHED") {
      conditions.push(eq(blogPosts.status, status));
    }

    if (tag) {
      // Tags stored as JSON array text, e.g. '["fair","summer"]'
      conditions.push(sql`${blogPosts.tags} LIKE ${'%"' + tag.replace(/["%_\\]/g, "") + '"%'}`);
    }

    if (after) {
      const afterDate = new Date(after);
      if (!isNaN(afterDate.getTime())) {
        conditions.push(gt(blogPosts.publishDate, afterDate));
      }
    }

    if (before) {
      const beforeDate = new Date(before);
      if (!isNaN(beforeDate.getTime())) {
        conditions.push(lt(blogPosts.publishDate, beforeDate));
      }
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [posts, countResult] = await Promise.all([
      db
        .select({
          id: blogPosts.id,
          title: blogPosts.title,
          slug: blogPosts.slug,
          excerpt: blogPosts.excerpt,
          authorId: blogPosts.authorId,
          authorName: users.name,
          tags: blogPosts.tags,
          categories: blogPosts.categories,
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
        .where(where)
        .orderBy(desc(blogPosts.publishDate))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)` })
        .from(blogPosts)
        .where(where),
    ]);

    return NextResponse.json({
      posts: posts.map((p) => ({
        ...p,
        tags: JSON.parse(p.tags || "[]"),
        categories: JSON.parse(p.categories || "[]"),
      })),
      total: countResult[0].count,
      limit,
      offset,
    });
  } catch (error) {
    await logError(db, {
      message: "Error listing blog posts",
      error,
      source: "api/blog-posts",
      request,
    });
    return NextResponse.json({ error: "Failed to list blog posts" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const db = getCloudflareDb();
  const { authorized, userId } = await getAuthorizedSession(request);

  if (!authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const validation = await validateRequestBody(request, blogPostCreateSchema);
  if (!validation.success) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const data = validation.data;

  try {
    // Determine author: explicit authorId, session userId, or fail
    const authorId = data.authorId || userId;
    if (!authorId) {
      return NextResponse.json(
        { error: "authorId is required when using API key authentication" },
        { status: 400 }
      );
    }

    // Generate unique slug
    const baseSlug = createSlug(data.title);
    if (!baseSlug) {
      return NextResponse.json(
        { error: "Title must contain alphanumeric characters" },
        { status: 400 }
      );
    }

    const [lowerBound, upperBound] = getSlugPrefixBounds(baseSlug);
    const existing = await db
      .select({ slug: blogPosts.slug })
      .from(blogPosts)
      .where(
        or(
          eq(blogPosts.slug, baseSlug),
          and(gt(blogPosts.slug, lowerBound), lt(blogPosts.slug, upperBound))
        )
      );
    const slug = findUniqueSlug(
      baseSlug,
      existing.map((r) => r.slug)
    );

    // If publishing with no explicit publishDate, set it to now
    const publishDate =
      data.status === "PUBLISHED" && !data.publishDate
        ? new Date()
        : data.publishDate
          ? new Date(data.publishDate)
          : null;

    const id = crypto.randomUUID();
    await db.insert(blogPosts).values({
      id,
      title: data.title,
      slug,
      body: data.body,
      excerpt: data.excerpt || null,
      authorId,
      tags: JSON.stringify(data.tags),
      categories: JSON.stringify(data.categories),
      featuredImageUrl: data.featuredImageUrl || null,
      status: data.status,
      publishDate,
      metaTitle: data.metaTitle || null,
      metaDescription: data.metaDescription || null,
    });

    const [created] = await db.select().from(blogPosts).where(eq(blogPosts.id, id)).limit(1);

    let warnings: { brokenLinks: string[] } | undefined;
    try {
      const broken = await findBrokenLinksInDb(db, data.body);
      if (broken.length > 0) warnings = { brokenLinks: broken };
    } catch {
      /* non-fatal */
    }

    // Update the content-link index from the saved body. Failures are logged
    // but don't block the create — the backfill script can reconcile later.
    try {
      await syncContentLinks(db, id, data.body, { notify: true });
    } catch (err) {
      await logError(db, {
        level: "warn",
        message: "syncContentLinks failed after blog post create",
        error: err,
        source: "api/blog-posts:POST",
        context: { blogPostId: id },
      });
    }

    return NextResponse.json(
      {
        ...created,
        tags: JSON.parse(created.tags || "[]"),
        categories: JSON.parse(created.categories || "[]"),
        ...(warnings ? { warnings } : {}),
      },
      { status: 201 }
    );
  } catch (error) {
    await logError(db, {
      message: "Error creating blog post",
      error,
      source: "api/blog-posts",
      request,
    });
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
      return NextResponse.json(
        { error: "A blog post with this slug already exists" },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: "Failed to create blog post" }, { status: 500 });
  }
}
