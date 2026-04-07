import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq, and, desc, sql } from "drizzle-orm";
import { blogPosts, users } from "../schema.js";
import { parseJsonArray, formatDate, jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

interface Env {
  MAIN_APP_URL: string;
  INTERNAL_API_KEY: string;
}

const BLOG_STATUS_ENUM = ["DRAFT", "PUBLISHED"] as const;

export function registerBlogTools(server: McpServer, db: Db, auth: AuthContext, env?: Env) {
  if (auth.role !== "ADMIN") return;

  // ── create_blog_post ─────────────────────────────────────────────
  server.tool(
    "create_blog_post",
    "Create a new blog post. Body should be Markdown. Posts default to DRAFT status unless explicitly published.",
    {
      title: z.string().min(1).max(200).describe("Post title"),
      body: z.string().min(1).describe("Post body in Markdown format"),
      excerpt: z.string().max(500).optional().describe("Short excerpt/summary"),
      tags: z.array(z.string()).optional().describe("Array of tag strings"),
      categories: z.array(z.string()).optional().describe("Array of category strings"),
      featured_image_url: z.string().url().optional().describe("URL of the featured image"),
      status: z.enum(BLOG_STATUS_ENUM).optional().describe("DRAFT (default) or PUBLISHED"),
      publish_date: z
        .string()
        .optional()
        .describe("ISO 8601 publish date (auto-set when publishing if omitted)"),
      meta_title: z.string().max(70).optional().describe("SEO meta title (max 70 chars)"),
      meta_description: z
        .string()
        .max(160)
        .optional()
        .describe("SEO meta description (max 160 chars)"),
    },
    async (params) => {
      if (!env?.MAIN_APP_URL || !env?.INTERNAL_API_KEY) {
        return {
          content: [
            {
              type: "text",
              text: "Blog post creation requires MAIN_APP_URL and INTERNAL_API_KEY to be configured.",
            },
          ],
          isError: true,
        };
      }

      try {
        const response = await fetch(`${env.MAIN_APP_URL}/api/blog-posts`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Key": env.INTERNAL_API_KEY,
          },
          body: JSON.stringify({
            title: params.title,
            body: params.body,
            excerpt: params.excerpt,
            authorId: auth.userId,
            tags: params.tags || [],
            categories: params.categories || [],
            featuredImageUrl: params.featured_image_url,
            status: params.status || "DRAFT",
            publishDate: params.publish_date,
            metaTitle: params.meta_title,
            metaDescription: params.meta_description,
          }),
        });

        if (!response.ok) {
          const errorData = (await response.json().catch(() => ({}))) as Record<string, string>;
          return {
            content: [
              {
                type: "text",
                text: `Failed to create blog post (${response.status}): ${errorData.error || response.statusText}`,
              },
            ],
            isError: true,
          };
        }

        const result = await response.json();
        return { content: [jsonContent(result)] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Create blog post failed: ${error instanceof Error ? error.message : "Unknown error"}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── get_blog_post ────────────────────────────────────────────────
  server.tool(
    "get_blog_post",
    "Retrieve a single blog post by its slug. Returns full post including Markdown body, tags, categories, and author info.",
    {
      slug: z.string().min(1).describe("The URL slug of the blog post"),
    },
    async (params) => {
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
        .where(eq(blogPosts.slug, params.slug))
        .limit(1);

      if (!post) {
        return {
          content: [{ type: "text", text: `No blog post found with slug "${params.slug}"` }],
          isError: true,
        };
      }

      return {
        content: [
          jsonContent({
            ...post,
            tags: parseJsonArray(post.tags),
            categories: parseJsonArray(post.categories),
            publishDate: formatDate(post.publishDate),
            createdAt: formatDate(post.createdAt),
            updatedAt: formatDate(post.updatedAt),
          }),
        ],
      };
    }
  );

  // ── list_blog_posts ──────────────────────────────────────────────
  server.tool(
    "list_blog_posts",
    "List blog posts with optional filters for status and tag. Returns posts ordered by publish date (newest first). Admin sees all posts including drafts.",
    {
      status: z.enum(BLOG_STATUS_ENUM).optional().describe("Filter by status: DRAFT or PUBLISHED"),
      tag: z.string().optional().describe("Filter by tag name"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Number of posts to return (default 20, max 100)"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Number of results to skip for pagination (default 0)"),
    },
    async (params) => {
      const limit = params.limit || 20;
      const conditions = [];

      if (params.status) {
        conditions.push(eq(blogPosts.status, params.status));
      }

      if (params.tag) {
        const safeTag = params.tag.replace(/["%_\\]/g, "");
        conditions.push(sql`${blogPosts.tags} LIKE ${'%"' + safeTag + '"%'}`);
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const posts = await db
        .select({
          id: blogPosts.id,
          title: blogPosts.title,
          slug: blogPosts.slug,
          excerpt: blogPosts.excerpt,
          authorName: users.name,
          tags: blogPosts.tags,
          categories: blogPosts.categories,
          status: blogPosts.status,
          publishDate: blogPosts.publishDate,
          createdAt: blogPosts.createdAt,
        })
        .from(blogPosts)
        .leftJoin(users, eq(blogPosts.authorId, users.id))
        .where(where)
        .orderBy(desc(blogPosts.publishDate))
        .limit(limit)
        .offset(params.offset ?? 0);

      const offset = params.offset ?? 0;

      return {
        content: [
          jsonContent({
            count: posts.length,
            offset,
            has_more: posts.length === limit,
            posts: posts.map((p) => ({
              ...p,
              tags: parseJsonArray(p.tags),
              categories: parseJsonArray(p.categories),
              publishDate: formatDate(p.publishDate),
              createdAt: formatDate(p.createdAt),
            })),
          }),
        ],
      };
    }
  );

  // ── update_blog_post ─────────────────────────────────────────────
  server.tool(
    "update_blog_post",
    "Update an existing blog post by slug. Only provided fields are changed. Body should be Markdown.",
    {
      slug: z.string().min(1).describe("Current slug of the post to update"),
      title: z.string().min(1).max(200).optional().describe("New title"),
      body: z.string().min(1).optional().describe("New body in Markdown format"),
      excerpt: z.string().max(500).optional().describe("New excerpt/summary"),
      tags: z.array(z.string()).optional().describe("New tags array (replaces existing)"),
      categories: z
        .array(z.string())
        .optional()
        .describe("New categories array (replaces existing)"),
      featured_image_url: z.string().url().optional().describe("New featured image URL"),
      status: z.enum(BLOG_STATUS_ENUM).optional().describe("New status: DRAFT or PUBLISHED"),
      publish_date: z.string().optional().describe("New publish date (ISO 8601)"),
      meta_title: z.string().max(70).optional().describe("New SEO meta title"),
      meta_description: z.string().max(160).optional().describe("New SEO meta description"),
    },
    async (params) => {
      if (!env?.MAIN_APP_URL || !env?.INTERNAL_API_KEY) {
        return {
          content: [
            {
              type: "text",
              text: "Blog post update requires MAIN_APP_URL and INTERNAL_API_KEY to be configured.",
            },
          ],
          isError: true,
        };
      }

      try {
        // Build update payload with only provided fields
        const payload: Record<string, unknown> = {};
        if (params.title !== undefined) payload.title = params.title;
        if (params.body !== undefined) payload.body = params.body;
        if (params.excerpt !== undefined) payload.excerpt = params.excerpt;
        if (params.tags !== undefined) payload.tags = params.tags;
        if (params.categories !== undefined) payload.categories = params.categories;
        if (params.featured_image_url !== undefined)
          payload.featuredImageUrl = params.featured_image_url;
        if (params.status !== undefined) payload.status = params.status;
        if (params.publish_date !== undefined) payload.publishDate = params.publish_date;
        if (params.meta_title !== undefined) payload.metaTitle = params.meta_title;
        if (params.meta_description !== undefined)
          payload.metaDescription = params.meta_description;

        const response = await fetch(
          `${env.MAIN_APP_URL}/api/blog-posts/${encodeURIComponent(params.slug)}`,
          {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              "X-Internal-Key": env.INTERNAL_API_KEY,
            },
            body: JSON.stringify(payload),
          }
        );

        if (!response.ok) {
          const errorData = (await response.json().catch(() => ({}))) as Record<string, string>;
          return {
            content: [
              {
                type: "text",
                text: `Failed to update blog post (${response.status}): ${errorData.error || response.statusText}`,
              },
            ],
            isError: true,
          };
        }

        const result = await response.json();
        return { content: [jsonContent(result)] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Update blog post failed: ${error instanceof Error ? error.message : "Unknown error"}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── update_blog_post_status ──────────────────────────────────────
  server.tool(
    "update_blog_post_status",
    "Publish or unpublish a blog post. Convenience wrapper that toggles the status field. When publishing, the publish date is auto-set if not already set.",
    {
      slug: z.string().min(1).describe("Slug of the blog post"),
      status: z.enum(BLOG_STATUS_ENUM).describe("New status: DRAFT or PUBLISHED"),
    },
    async (params) => {
      if (!env?.MAIN_APP_URL || !env?.INTERNAL_API_KEY) {
        return {
          content: [
            {
              type: "text",
              text: "Blog post status update requires MAIN_APP_URL and INTERNAL_API_KEY to be configured.",
            },
          ],
          isError: true,
        };
      }

      try {
        const response = await fetch(
          `${env.MAIN_APP_URL}/api/blog-posts/${encodeURIComponent(params.slug)}`,
          {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              "X-Internal-Key": env.INTERNAL_API_KEY,
            },
            body: JSON.stringify({ status: params.status }),
          }
        );

        if (!response.ok) {
          const errorData = (await response.json().catch(() => ({}))) as Record<string, string>;
          return {
            content: [
              {
                type: "text",
                text: `Failed to update status (${response.status}): ${errorData.error || response.statusText}`,
              },
            ],
            isError: true,
          };
        }

        const result = (await response.json()) as Record<string, unknown>;
        return {
          content: [
            {
              type: "text",
              text: `Blog post "${result.title}" status changed to ${params.status}. Slug: ${result.slug}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Status update failed: ${error instanceof Error ? error.message : "Unknown error"}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── delete_blog_post ────────────────────────────────────────────
  server.tool(
    "delete_blog_post",
    "Permanently delete a blog post by slug. Admin only.",
    {
      slug: z.string().min(1).describe("Slug of the blog post to delete"),
    },
    async (params) => {
      if (!env?.MAIN_APP_URL || !env?.INTERNAL_API_KEY) {
        return {
          content: [
            {
              type: "text",
              text: "Blog post deletion requires MAIN_APP_URL and INTERNAL_API_KEY to be configured.",
            },
          ],
          isError: true,
        };
      }

      try {
        const response = await fetch(
          `${env.MAIN_APP_URL}/api/blog-posts/${encodeURIComponent(params.slug)}`,
          {
            method: "DELETE",
            headers: {
              "X-Internal-Key": env.INTERNAL_API_KEY,
            },
          }
        );

        if (!response.ok) {
          const errorData = (await response.json().catch(() => ({}))) as Record<string, string>;
          return {
            content: [
              {
                type: "text",
                text: `Failed to delete blog post (${response.status}): ${errorData.error || response.statusText}`,
              },
            ],
            isError: true,
          };
        }

        return {
          content: [jsonContent({ deleted: true, slug: params.slug })],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Delete blog post failed: ${error instanceof Error ? error.message : "Unknown error"}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
