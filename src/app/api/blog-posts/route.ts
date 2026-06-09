import { NextRequest, NextResponse } from "next/server";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { blogPosts, users } from "@/lib/db/schema";
import { isAuthorized, getAuthorizedSession } from "@/lib/api-auth";
import { blogPostCreateSchema, validateRequestBody } from "@/lib/validations";
import { findBrokenContentLinksInDb, findBrokenLinksInDb } from "@/lib/blog-links";
import { syncContentLinks } from "@/lib/content-links-sync";
import { createSlug, getSlugPrefixBounds, findUniqueSlug, unsafeSlug } from "@/lib/utils";
import { logError } from "@/lib/logger";
import { eq, and, or, gt, lt, desc, sql } from "drizzle-orm";
import { pingIndexNow, indexNowUrlFor } from "@/lib/indexnow";

export const runtime = "edge";

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
          // F1 — surface focal columns so admin form can re-populate the
          // picker with the current value on edit (matches the events
          // detail SELECT pattern).
          imageFocalX: blogPosts.imageFocalX,
          imageFocalY: blogPosts.imageFocalY,
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
          eq(blogPosts.slug, unsafeSlug(baseSlug)),
          and(
            gt(blogPosts.slug, unsafeSlug(lowerBound)),
            lt(blogPosts.slug, unsafeSlug(upperBound))
          )
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
      faqs: JSON.stringify(data.faqs),
      featuredImageUrl: data.featuredImageUrl || null,
      // F1 (PR #412 deferred-finisher, 2026-06-08) — pass focal-point through
      // when provided so the MCP create_blog_post tool's image_focal_x/y
      // args actually persist. The Drizzle column defaults to 0.5/0.5 when
      // omitted, which matches `gravity` short-circuit semantics: center
      // → URL identical to pre-F1 (preserves CF derivative cache key).
      // Mirrors the pattern at src/app/api/admin/events/[id]/route.ts:237-241.
      ...(typeof data.imageFocalX === "number" && Number.isFinite(data.imageFocalX)
        ? { imageFocalX: Math.max(0, Math.min(1, data.imageFocalX)) }
        : {}),
      ...(typeof data.imageFocalY === "number" && Number.isFinite(data.imageFocalY)
        ? { imageFocalY: Math.max(0, Math.min(1, data.imageFocalY)) }
        : {}),
      status: data.status,
      publishDate,
      metaTitle: data.metaTitle || null,
      metaDescription: data.metaDescription || null,
    });

    const [created] = await db.select().from(blogPosts).where(eq(blogPosts.id, id)).limit(1);

    // Broken-link warnings — flagged, not rejected (the analyst's 2026-05-24
    // ask said "rejects or flags"; we go with flag-only to match existing
    // PUT behavior and avoid surprising authoring flows). brokenLinks is
    // legacy /blog/ refs only; brokenContentLinks covers all four target
    // types (EVENT/VENDOR/VENUE/BLOG_POST) and catches the analyst's four
    // observed patterns: prefix-suffix year swap, fabricated name-venue
    // slugs, ordinal prefixes, and singular-path typos.
    let warnings:
      | {
          brokenLinks?: string[];
          brokenContentLinks?: Array<{ targetType: string; targetSlug: string }>;
        }
      | undefined;
    try {
      const [brokenBlog, brokenContent] = await Promise.all([
        findBrokenLinksInDb(db, data.body),
        findBrokenContentLinksInDb(db, data.body),
      ]);
      const out: NonNullable<typeof warnings> = {};
      if (brokenBlog.length > 0) out.brokenLinks = brokenBlog;
      if (brokenContent.length > 0) out.brokenContentLinks = brokenContent;
      if (Object.keys(out).length > 0) warnings = out;
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

    // IndexNow: ping when a new post is created already PUBLISHED.
    if (data.status === "PUBLISHED") {
      const env = getCloudflareEnv() as unknown as { INDEXNOW_KEY?: string };
      await pingIndexNow(db, indexNowUrlFor("blog", slug), env, "blog-create");
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
