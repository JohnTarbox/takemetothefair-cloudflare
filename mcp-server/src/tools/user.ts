import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { userFavorites, events, venues, vendors, promoters } from "../schema.js";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

export function registerUserTools(server: McpServer, db: Db, auth: AuthContext) {
  // ── get_my_favorites ───────────────────────────────────────────
  server.tool(
    "get_my_favorites",
    "List your favorited events, vendors, venues, and promoters.",
    {
      type: z
        .enum(["EVENT", "VENUE", "VENDOR", "PROMOTER"])
        .optional()
        .describe("Filter by favorite type"),
    },
    async (params) => {
      const conditions = [eq(userFavorites.userId, auth.userId)];
      if (params.type) {
        conditions.push(eq(userFavorites.favoritableType, params.type));
      }

      const favs = await db
        .select()
        .from(userFavorites)
        .where(and(...conditions));

      // Resolve names for each favorite
      // Use allSettled so a single deleted favorite target doesn't fail the whole list
      const results = await Promise.allSettled(
        favs.map(async (fav) => {
          let name: string | null = null;
          let slug: string | null = null;

          switch (fav.favoritableType) {
            case "EVENT": {
              const rows = await db
                .select({ name: events.name, slug: events.slug })
                .from(events)
                .where(eq(events.id, fav.favoritableId))
                .limit(1);
              if (rows[0]) { name = rows[0].name; slug = rows[0].slug; }
              break;
            }
            case "VENUE": {
              const rows = await db
                .select({ name: venues.name, slug: venues.slug })
                .from(venues)
                .where(eq(venues.id, fav.favoritableId))
                .limit(1);
              if (rows[0]) { name = rows[0].name; slug = rows[0].slug; }
              break;
            }
            case "VENDOR": {
              const rows = await db
                .select({ name: vendors.businessName, slug: vendors.slug })
                .from(vendors)
                .where(eq(vendors.id, fav.favoritableId))
                .limit(1);
              if (rows[0]) { name = rows[0].name; slug = rows[0].slug; }
              break;
            }
            case "PROMOTER": {
              const rows = await db
                .select({ name: promoters.companyName, slug: promoters.slug })
                .from(promoters)
                .where(eq(promoters.id, fav.favoritableId))
                .limit(1);
              if (rows[0]) { name = rows[0].name; slug = rows[0].slug; }
              break;
            }
          }

          return {
            type: fav.favoritableType,
            id: fav.favoritableId,
            name,
            slug,
          };
        }),
      );

      const resolved = results
        .filter((r) => r.status === "fulfilled")
        .map((r) => (r as PromiseFulfilledResult<{ type: string; id: string; name: string | null; slug: string | null }>).value);

      return { content: [jsonContent({ count: resolved.length, favorites: resolved })] };
    },
  );

  // ── toggle_favorite ────────────────────────────────────────────
  server.tool(
    "toggle_favorite",
    "Add or remove a favorite. Returns whether the item is now favorited.",
    {
      type: z.enum(["EVENT", "VENUE", "VENDOR", "PROMOTER"]).describe("Type of item to favorite"),
      id: z.string().describe("ID of the item to favorite"),
    },
    async (params) => {
      // Check if already favorited
      const existing = await db
        .select({ id: userFavorites.id })
        .from(userFavorites)
        .where(
          and(
            eq(userFavorites.userId, auth.userId),
            eq(userFavorites.favoritableType, params.type),
            eq(userFavorites.favoritableId, params.id),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        // Remove favorite
        await db
          .delete(userFavorites)
          .where(eq(userFavorites.id, existing[0].id));
        return { content: [jsonContent({ favorited: false, type: params.type, id: params.id })] };
      } else {
        // Add favorite
        const id = crypto.randomUUID();
        await db.insert(userFavorites).values({
          id,
          userId: auth.userId,
          favoritableType: params.type,
          favoritableId: params.id,
        });
        return { content: [jsonContent({ favorited: true, type: params.type, id: params.id })] };
      }
    },
  );
}
