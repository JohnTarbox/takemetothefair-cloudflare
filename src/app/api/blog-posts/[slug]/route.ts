import { NextRequest, NextResponse } from "next/server";
import { getCloudflareDb } from "@/lib/cloudflare";
import { blogPosts, users } from "@/lib/db/schema";
import { isAuthorized } from "@/lib/api-auth";
import { blogPostUpdateSchema, validateRequestBody } from "@/lib/validations";
import { createSlug, getSlugPrefixBounds, findUniqueSlug } from "@/lib/utils";
import { logError } from "@/lib/logger";
import { eq, and, or, gt, lt, ne } from "drizzle-orm";

export const runtime = "edge";

interface Params {
  params: Promise<{ slug: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  const db = getCloudflareDb();
  const { slug } = await params;
  const admin = await isAuthorized(request);

  try {
    const conditions = [eq(blogPosts.slug, slug)];
    // Non-admin users can only see published posts
    if (!admin) {
      conditions.push(eq(blogPosts.status, "PUBLISHED"));
    }

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
      .where(and(...conditions))
      .limit(1);

    if (!post) {
      return NextResponse.json({ error: "Blog post not found" }, { status: 404 });
    }

    return NextResponse.json({
      ...post,
      tags: JSON.parse(post.tags || "[]"),
      categories: JSON.parse(post.categories || "[]"),
    });
  } catch (error) {
    await logError(db, {
      message: "Error fetching blog post",
      error,
      source: "api/blog-posts/[slug]",
      request,
    });
    return NextResponse.json({ error: "Failed to fetch blog post" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest, { params }: Params) {
  const db = getCloudflareDb();
  const { slug } = await params;

  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const validation = await validateRequestBody(request, blogPostUpdateSchema);
  if (!validation.success) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const data = validation.data;

  try {
    // Fetch the existing post
    const [existing] = await db
      .select()
      .from(blogPosts)
      .where(eq(blogPosts.slug, slug))
      .limit(1);

    if (!existing) {
      return NextResponse.json({ error: "Blog post not found" }, { status: 404 });
    }

    const updateData: Record<string, unknown> = { updatedAt: new Date() };

    if (data.title !== undefined) {
      updateData.title = data.title;

      // Regenerate slug if title changed
      const baseSlug = createSlug(data.title);
      if (baseSlug && baseSlug !== existing.slug) {
        const [lowerBound, upperBound] = getSlugPrefixBounds(baseSlug);
        const existingSlugs = await db
          .select({ slug: blogPosts.slug })
          .from(blogPosts)
          .where(and(
            ne(blogPosts.id, existing.id),
            or(
              eq(blogPosts.slug, baseSlug),
              and(gt(blogPosts.slug, lowerBound), lt(blogPosts.slug, upperBound))
            )
          ));
        updateData.slug = findUniqueSlug(baseSlug, existingSlugs.map((r) => r.slug));
      }
    }

    if (data.body !== undefined) updateData.body = data.body;
    if (data.excerpt !== undefined) updateData.excerpt = data.excerpt;
    if (data.tags !== undefined) updateData.tags = JSON.stringify(data.tags);
    if (data.categories !== undefined) updateData.categories = JSON.stringify(data.categories);
    if (data.featuredImageUrl !== undefined) updateData.featuredImageUrl = data.featuredImageUrl;
    if (data.metaTitle !== undefined) updateData.metaTitle = data.metaTitle;
    if (data.metaDescription !== undefined) updateData.metaDescription = data.metaDescription;

    if (data.status !== undefined) {
      updateData.status = data.status;
      // If publishing for the first time and no explicit publishDate, set it
      if (data.status === "PUBLISHED" && !existing.publishDate && !data.publishDate) {
        updateData.publishDate = new Date();
      }
    }

    if (data.publishDate !== undefined) {
      updateData.publishDate = data.publishDate ? new Date(data.publishDate) : null;
    }

    await db
      .update(blogPosts)
      .set(updateData)
      .where(eq(blogPosts.id, existing.id));

    // Fetch the updated post with author info
    const [updated] = await db
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
      .where(eq(blogPosts.id, existing.id))
      .limit(1);

    return NextResponse.json({
      ...updated,
      tags: JSON.parse(updated.tags || "[]"),
      categories: JSON.parse(updated.categories || "[]"),
    });
  } catch (error) {
    await logError(db, {
      message: "Error updating blog post",
      error,
      source: "api/blog-posts/[slug]",
      request,
    });
    return NextResponse.json({ error: "Failed to update blog post" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const db = getCloudflareDb();
  const { slug } = await params;

  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const [existing] = await db
      .select({ id: blogPosts.id })
      .from(blogPosts)
      .where(eq(blogPosts.slug, slug))
      .limit(1);

    if (!existing) {
      return NextResponse.json({ error: "Blog post not found" }, { status: 404 });
    }

    await db.delete(blogPosts).where(eq(blogPosts.id, existing.id));

    return NextResponse.json({ success: true });
  } catch (error) {
    await logError(db, {
      message: "Error deleting blog post",
      error,
      source: "api/blog-posts/[slug]",
      request,
    });
    return NextResponse.json({ error: "Failed to delete blog post" }, { status: 500 });
  }
}
