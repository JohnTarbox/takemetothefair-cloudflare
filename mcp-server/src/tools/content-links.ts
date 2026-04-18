import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { blogPosts, contentLinks, events, vendors, venues } from "../schema.js";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

const ENTITY_TYPES = ["EVENT", "VENDOR", "VENUE"] as const;
type EntityType = (typeof ENTITY_TYPES)[number];

interface UncoveredRow {
  type: EntityType;
  id: string;
  slug: string;
  name: string;
  state: string | null;
}

/**
 * Content-link MCP tools. Admin-only: coverage reporting surfaces gaps in
 * editorial coverage, which we don't want exposed to vendors/promoters.
 */
export function registerContentLinksTools(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  // ── list_entities_without_blog_coverage ──────────────────────────
  server.tool(
    "list_entities_without_blog_coverage",
    "List events/vendors/venues with zero linked blog posts — the primary 'what should I write next?' query. Admin only.",
    {
      entity_type: z
        .enum(["EVENT", "VENDOR", "VENUE", "ALL"])
        .optional()
        .default("ALL")
        .describe("Limit to one entity type, or ALL for all three"),
      state: z
        .string()
        .length(2)
        .optional()
        .describe("Filter by 2-letter state code (events via venue, vendors, venues)"),
      limit: z.number().int().min(1).max(200).optional().default(50),
      offset: z.number().int().min(0).optional().default(0),
    },
    async ({ entity_type, state, limit, offset }) => {
      const types: EntityType[] =
        entity_type === "ALL" ? [...ENTITY_TYPES] : [entity_type as EntityType];
      const stateCode = state?.toUpperCase();

      const results: UncoveredRow[] = [];

      // Shared: ids of entities already covered by a PUBLISHED link, for a given type
      const coveredIdsFor = async (type: EntityType): Promise<string[]> => {
        const rows = await db
          .select({ id: contentLinks.targetId })
          .from(contentLinks)
          .innerJoin(blogPosts, eq(contentLinks.sourceId, blogPosts.id))
          .where(
            and(
              eq(contentLinks.sourceType, "BLOG_POST"),
              eq(contentLinks.targetType, type),
              eq(blogPosts.status, "PUBLISHED")
            )
          );
        return rows.map((r) => r.id).filter((id): id is string => !!id);
      };

      if (types.includes("EVENT")) {
        const covered = await coveredIdsFor("EVENT");
        const whereParts = [
          covered.length > 0 ? notInArray(events.id, covered) : sql`1=1`,
          stateCode ? eq(venues.state, stateCode) : sql`1=1`,
        ];
        const rows = await db
          .select({
            id: events.id,
            slug: events.slug,
            name: events.name,
            state: venues.state,
          })
          .from(events)
          .leftJoin(venues, eq(events.venueId, venues.id))
          .where(and(...whereParts));
        for (const r of rows) {
          results.push({ type: "EVENT", id: r.id, slug: r.slug, name: r.name, state: r.state });
        }
      }

      if (types.includes("VENDOR")) {
        const covered = await coveredIdsFor("VENDOR");
        const whereParts = [
          covered.length > 0 ? notInArray(vendors.id, covered) : sql`1=1`,
          stateCode ? eq(vendors.state, stateCode) : sql`1=1`,
        ];
        const rows = await db
          .select({
            id: vendors.id,
            slug: vendors.slug,
            name: vendors.businessName,
            state: vendors.state,
          })
          .from(vendors)
          .where(and(...whereParts));
        for (const r of rows) {
          results.push({ type: "VENDOR", id: r.id, slug: r.slug, name: r.name, state: r.state });
        }
      }

      if (types.includes("VENUE")) {
        const covered = await coveredIdsFor("VENUE");
        const whereParts = [
          covered.length > 0 ? notInArray(venues.id, covered) : sql`1=1`,
          stateCode ? eq(venues.state, stateCode) : sql`1=1`,
        ];
        const rows = await db
          .select({
            id: venues.id,
            slug: venues.slug,
            name: venues.name,
            state: venues.state,
          })
          .from(venues)
          .where(and(...whereParts));
        for (const r of rows) {
          results.push({ type: "VENUE", id: r.id, slug: r.slug, name: r.name, state: r.state });
        }
      }

      const paged = results.slice(offset, offset + limit);
      return {
        content: [jsonContent({ entities: paged, total: results.length, limit, offset })],
      };
    }
  );

  // ── get_blog_coverage ───────────────────────────────────────────
  server.tool(
    "get_blog_coverage",
    "Given an event/vendor/venue ID, return the blog posts that directly link to it (via /events/<slug>, /vendors/<slug>, or /venues/<slug> in the body). Admin only.",
    {
      entity_type: z.enum(["EVENT", "VENDOR", "VENUE"]),
      id: z.string().min(1),
    },
    async ({ entity_type, id }) => {
      const rows = await db
        .select({
          slug: blogPosts.slug,
          title: blogPosts.title,
          excerpt: blogPosts.excerpt,
          publish_date: blogPosts.publishDate,
          status: blogPosts.status,
        })
        .from(contentLinks)
        .innerJoin(blogPosts, eq(contentLinks.sourceId, blogPosts.id))
        .where(
          and(
            eq(contentLinks.sourceType, "BLOG_POST"),
            eq(contentLinks.targetType, entity_type),
            eq(contentLinks.targetId, id)
          )
        )
        .orderBy(desc(blogPosts.publishDate));
      return { content: [jsonContent({ blog_posts: rows })] };
    }
  );

  // ── get_blog_links_in_post ──────────────────────────────────────
  server.tool(
    "get_blog_links_in_post",
    "Given a blog post slug, return the events/vendors/venues it links to. Resolves target names where possible; unresolved slugs appear with target_id=null. Admin only.",
    {
      slug: z.string().min(1),
    },
    async ({ slug }) => {
      const [post] = await db
        .select({ id: blogPosts.id, slug: blogPosts.slug, title: blogPosts.title })
        .from(blogPosts)
        .where(eq(blogPosts.slug, slug))
        .limit(1);
      if (!post) {
        return { content: [jsonContent({ error: "Blog post not found" })] };
      }

      const links = await db
        .select({
          targetType: contentLinks.targetType,
          targetSlug: contentLinks.targetSlug,
          targetId: contentLinks.targetId,
        })
        .from(contentLinks)
        .where(and(eq(contentLinks.sourceType, "BLOG_POST"), eq(contentLinks.sourceId, post.id)));

      // Bucket ids by target type so we can resolve names with one query each.
      const idsByType: Record<EntityType, string[]> = { EVENT: [], VENDOR: [], VENUE: [] };
      for (const link of links) {
        if (!link.targetId) continue;
        const t = link.targetType as EntityType;
        idsByType[t].push(link.targetId);
      }

      const nameById = new Map<string, string>();
      if (idsByType.EVENT.length > 0) {
        const rows = await db
          .select({ id: events.id, name: events.name })
          .from(events)
          .where(inArray(events.id, idsByType.EVENT));
        for (const r of rows) nameById.set(r.id, r.name);
      }
      if (idsByType.VENDOR.length > 0) {
        const rows = await db
          .select({ id: vendors.id, name: vendors.businessName })
          .from(vendors)
          .where(inArray(vendors.id, idsByType.VENDOR));
        for (const r of rows) nameById.set(r.id, r.name);
      }
      if (idsByType.VENUE.length > 0) {
        const rows = await db
          .select({ id: venues.id, name: venues.name })
          .from(venues)
          .where(inArray(venues.id, idsByType.VENUE));
        for (const r of rows) nameById.set(r.id, r.name);
      }

      return {
        content: [
          jsonContent({
            post: { slug: post.slug, title: post.title },
            links: links.map((l) => ({
              target_type: l.targetType,
              target_slug: l.targetSlug,
              target_id: l.targetId,
              target_name: l.targetId ? (nameById.get(l.targetId) ?? null) : null,
              resolved: !!l.targetId,
            })),
          }),
        ],
      };
    }
  );

  // ── get_blog_coverage_stats ─────────────────────────────────────
  server.tool(
    "get_blog_coverage_stats",
    "Aggregate coverage numbers — total published links, entities with/without coverage, average links per post, top-linked entities. Admin only.",
    {},
    async () => {
      // All content links from PUBLISHED posts
      const allLinks = await db
        .select({
          targetType: contentLinks.targetType,
          targetId: contentLinks.targetId,
          sourceId: contentLinks.sourceId,
        })
        .from(contentLinks)
        .innerJoin(blogPosts, eq(contentLinks.sourceId, blogPosts.id))
        .where(and(eq(contentLinks.sourceType, "BLOG_POST"), eq(blogPosts.status, "PUBLISHED")));

      const linksByTarget = new Map<string, number>(); // "TYPE|id" → count
      const linksPerPost = new Map<string, number>();
      for (const l of allLinks) {
        if (l.targetId) {
          const k = `${l.targetType}|${l.targetId}`;
          linksByTarget.set(k, (linksByTarget.get(k) ?? 0) + 1);
        }
        linksPerPost.set(l.sourceId, (linksPerPost.get(l.sourceId) ?? 0) + 1);
      }

      const [eventTotal] = await db.select({ n: sql<number>`count(*)` }).from(events);
      const [vendorTotal] = await db.select({ n: sql<number>`count(*)` }).from(vendors);
      const [venueTotal] = await db.select({ n: sql<number>`count(*)` }).from(venues);

      const withCoverage = (type: EntityType) =>
        new Set(
          allLinks
            .filter((l) => l.targetType === type && l.targetId)
            .map((l) => l.targetId as string)
        ).size;

      const topLinked = Array.from(linksByTarget.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([key, count]) => {
          const [type, id] = key.split("|");
          return { target_type: type, target_id: id, link_count: count };
        });

      const postCount = linksPerPost.size;
      const avgLinksPerPost =
        postCount > 0
          ? Array.from(linksPerPost.values()).reduce((a, b) => a + b, 0) / postCount
          : 0;

      return {
        content: [
          jsonContent({
            total_links: allLinks.length,
            events_with_coverage: withCoverage("EVENT"),
            events_total: Number(eventTotal?.n ?? 0),
            vendors_with_coverage: withCoverage("VENDOR"),
            vendors_total: Number(vendorTotal?.n ?? 0),
            venues_with_coverage: withCoverage("VENUE"),
            venues_total: Number(venueTotal?.n ?? 0),
            posts_with_links: postCount,
            avg_links_per_post: Math.round(avgLinksPerPost * 10) / 10,
            top_linked: topLinked,
          }),
        ],
      };
    }
  );
}
