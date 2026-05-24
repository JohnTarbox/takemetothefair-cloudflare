import { NextRequest, NextResponse } from "next/server";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { blogPosts, blogSlugHistory, contentLinks, users } from "@/lib/db/schema";
import { isAuthorized } from "@/lib/api-auth";
import { blogPostUpdateSchema, validateRequestBody } from "@/lib/validations";
import { createSlug, getSlugPrefixBounds, findUniqueSlug, unsafeSlug } from "@/lib/utils";
import { logError } from "@/lib/logger";
import { eq, and, or, gt, lt, ne } from "drizzle-orm";
import { findBrokenLinksInDb } from "@/lib/blog-links";
import { syncContentLinks } from "@/lib/content-links-sync";
import { pingIndexNow, indexNowUrlFor } from "@/lib/indexnow";

export const runtime = "edge";

interface Params {
  params: Promise<{ slug: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  const db = getCloudflareDb();
  const { slug } = await params;
  const admin = await isAuthorized(request);

  try {
    const conditions = [eq(blogPosts.slug, unsafeSlug(slug))];
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
      .where(eq(blogPosts.slug, unsafeSlug(slug)))
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
          .where(
            and(
              ne(blogPosts.id, existing.id),
              or(
                eq(blogPosts.slug, baseSlug),
                and(
                  gt(blogPosts.slug, unsafeSlug(lowerBound)),
                  lt(blogPosts.slug, unsafeSlug(upperBound))
                )
              )
            )
          );
        updateData.slug = findUniqueSlug(
          baseSlug,
          existingSlugs.map((r) => r.slug)
        );
      }
    }

    if (data.body !== undefined) updateData.body = data.body;
    if (data.excerpt !== undefined) updateData.excerpt = data.excerpt;
    if (data.tags !== undefined) updateData.tags = JSON.stringify(data.tags);
    if (data.categories !== undefined) updateData.categories = JSON.stringify(data.categories);
    if (data.faqs !== undefined) updateData.faqs = JSON.stringify(data.faqs);
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

    // Record slug-rename history before the update lands, so a request to
    // the OLD slug arriving in the gap between this write and the read
    // (or after, once propagation completes) 301s through the middleware
    // to the new slug rather than 404ing. Batched with the UPDATE so an
    // FK-violation in the history insert rolls the whole rename back.
    const slugChanged = typeof updateData.slug === "string" && updateData.slug !== existing.slug;
    const updateStatement = db
      .update(blogPosts)
      .set(updateData)
      .where(eq(blogPosts.id, existing.id));
    if (slugChanged) {
      await db.batch([
        db.insert(blogSlugHistory).values({
          blogPostId: existing.id,
          oldSlug: existing.slug,
          newSlug: unsafeSlug(updateData.slug as string),
          changedAt: new Date(),
        }),
        updateStatement,
      ]);
    } else {
      await updateStatement;
    }

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

    // Run a broken-link check on the saved body and surface warnings in the
    // response. Doesn't block the save — legitimate edits and cross-link
    // refactors need room to land before the target slug exists.
    let warnings: { brokenLinks: string[] } | undefined;
    if (data.body !== undefined) {
      try {
        const broken = await findBrokenLinksInDb(db, data.body);
        if (broken.length > 0) {
          warnings = { brokenLinks: broken };
        }
      } catch {
        /* non-fatal — skip warnings on query failure */
      }
    }

    // Re-derive the content-link index and fire promoter notifications for
    // any unnotified PUBLISHED EVENT links. Runs on every PUT (not just body
    // edits) so a DRAFT→PUBLISHED status flip with an existing link still
    // triggers the email.
    const bodyForSync = data.body !== undefined ? data.body : existing.body;
    try {
      await syncContentLinks(db, existing.id, bodyForSync, { notify: true });
    } catch (err) {
      await logError(db, {
        level: "warn",
        message: "syncContentLinks failed after blog post update",
        error: err,
        source: "api/blog-posts/[slug]:PUT",
        context: { blogPostId: existing.id },
      });
    }

    // IndexNow: ping when transitioning from DRAFT to PUBLISHED. Re-edits to
    // an already-published post don't ping.
    if (data.status === "PUBLISHED" && existing.status !== "PUBLISHED") {
      const finalSlug = (updateData.slug as string | undefined) ?? existing.slug;
      const env = getCloudflareEnv() as unknown as { INDEXNOW_KEY?: string };
      await pingIndexNow(db, indexNowUrlFor("blog", finalSlug), env, "blog-patch");
    }

    return NextResponse.json({
      ...updated,
      tags: JSON.parse(updated.tags || "[]"),
      categories: JSON.parse(updated.categories || "[]"),
      ...(warnings ? { warnings } : {}),
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
  // Optional ?successor=<slug> — for the consolidation case (the Paradise
  // City pattern). When set, we record a blog_slug_history row pointing
  // the deleted slug at the successor BEFORE deleting the original, so
  // the URL 301s instead of 404ing. blog_post_id on the history row is
  // the successor's id so the ON DELETE CASCADE behaves sensibly: if the
  // successor is later deleted, the inherited redirect dies with it
  // (correctly — at that point we'd want a 410, not a 301-to-nowhere).
  const successorSlug = new URL(request.url).searchParams.get("successor");

  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const [existing] = await db
      .select({ id: blogPosts.id, slug: blogPosts.slug })
      .from(blogPosts)
      .where(eq(blogPosts.slug, unsafeSlug(slug)))
      .limit(1);

    if (!existing) {
      return NextResponse.json({ error: "Blog post not found" }, { status: 404 });
    }

    // Resolve the successor up-front so a bad successor slug fails the
    // whole delete rather than orphaning the redirect attempt.
    let successorId: string | null = null;
    let successorCanonicalSlug: string | null = null;
    if (successorSlug) {
      const [successor] = await db
        .select({ id: blogPosts.id, slug: blogPosts.slug })
        .from(blogPosts)
        .where(eq(blogPosts.slug, unsafeSlug(successorSlug)))
        .limit(1);
      if (!successor) {
        return NextResponse.json(
          { error: "Successor blog post not found", successor: successorSlug },
          { status: 400 }
        );
      }
      if (successor.id === existing.id) {
        return NextResponse.json(
          { error: "Successor cannot be the same post being deleted" },
          { status: 400 }
        );
      }
      successorId = successor.id;
      successorCanonicalSlug = successor.slug;
    }

    // Cascade-delete content_links rows in both directions: rows authored
    // by this post (source_id) and rows pointing at this post as a
    // BLOG_POST target (target_id). Without this, the Paradise City
    // consolidation in May 2026 left 3 orphan rows pointing at a
    // non-existent source_id. content_links has no foreign keys, so the
    // cleanup must be application-level. Batched for atomicity per
    // feedback_destructive_delete_needs_transaction.md.
    //
    // When a successor is supplied, the blog_slug_history INSERT runs in
    // the same batch — the redirect is installed atomically with the
    // delete, so there's never a window where the URL 404s. The history
    // row's blog_post_id points at the SUCCESSOR (not the doomed
    // existing.id) which is why this insert can survive the
    // delete-from-blog_posts on the same row.
    const statements: Parameters<typeof db.batch>[0][number][] = [
      db.delete(contentLinks).where(eq(contentLinks.sourceId, existing.id)),
      db
        .delete(contentLinks)
        .where(
          and(eq(contentLinks.targetType, "BLOG_POST"), eq(contentLinks.targetId, existing.id))
        ),
    ];
    if (successorId && successorCanonicalSlug) {
      statements.push(
        db.insert(blogSlugHistory).values({
          blogPostId: successorId,
          oldSlug: existing.slug,
          newSlug: unsafeSlug(successorCanonicalSlug),
          changedAt: new Date(),
        })
      );
    }
    statements.push(db.delete(blogPosts).where(eq(blogPosts.id, existing.id)));
    await db.batch(statements as unknown as Parameters<typeof db.batch>[0]);

    return NextResponse.json({
      success: true,
      ...(successorCanonicalSlug ? { redirect_to: successorCanonicalSlug } : {}),
    });
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
