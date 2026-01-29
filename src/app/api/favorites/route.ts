import { NextRequest, NextResponse } from "next/server";
import { getCloudflareDb } from "@/lib/cloudflare";
import { userFavorites } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { validateRequestBody, favoriteSchema } from "@/lib/validations";
import { logError } from "@/lib/logger";

export const runtime = "edge";

const VALID_TYPES = ["EVENT", "VENUE", "VENDOR", "PROMOTER"] as const;
type FavoritableType = (typeof VALID_TYPES)[number];

export async function GET(request: NextRequest) {
  const db = getCloudflareDb();
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ favorites: [] });
    }

    const { searchParams } = new URL(request.url);
    const type = searchParams.get("type") as FavoritableType | null;

    let query = db
      .select({
        id: userFavorites.id,
        favoritableType: userFavorites.favoritableType,
        favoritableId: userFavorites.favoritableId,
      })
      .from(userFavorites)
      .where(eq(userFavorites.userId, session.user.id));

    if (type && VALID_TYPES.includes(type)) {
      query = db
        .select({
          id: userFavorites.id,
          favoritableType: userFavorites.favoritableType,
          favoritableId: userFavorites.favoritableId,
        })
        .from(userFavorites)
        .where(
          and(
            eq(userFavorites.userId, session.user.id),
            eq(userFavorites.favoritableType, type)
          )
        );
    }

    const favorites = await query;

    return NextResponse.json({ favorites });
  } catch (error) {
    await logError(db, { message: "Error fetching favorites", error, source: "api/favorites", request });
    return NextResponse.json(
      { error: "Failed to fetch favorites" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const db = getCloudflareDb();
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const validation = await validateRequestBody(request, favoriteSchema);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const { type, id } = validation.data;

    // Check if already favorited
    const existing = await db
      .select()
      .from(userFavorites)
      .where(
        and(
          eq(userFavorites.userId, session.user.id),
          eq(userFavorites.favoritableType, type),
          eq(userFavorites.favoritableId, id)
        )
      )
      .limit(1);

    if (existing.length > 0) {
      return NextResponse.json({ favorited: true, message: "Already favorited" });
    }

    // Add favorite
    await db.insert(userFavorites).values({
      userId: session.user.id,
      favoritableType: type,
      favoritableId: id,
    });

    return NextResponse.json({ favorited: true, message: "Added to favorites" });
  } catch (error) {
    await logError(db, { message: "Error adding favorite", error, source: "api/favorites", request });
    return NextResponse.json(
      { error: "Failed to add favorite" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  const db = getCloudflareDb();
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const type = searchParams.get("type") as FavoritableType | null;
    const id = searchParams.get("id");

    if (!type || !id || !VALID_TYPES.includes(type)) {
      return NextResponse.json(
        { error: "Invalid type or id" },
        { status: 400 }
      );
    }

    await db
      .delete(userFavorites)
      .where(
        and(
          eq(userFavorites.userId, session.user.id),
          eq(userFavorites.favoritableType, type),
          eq(userFavorites.favoritableId, id)
        )
      );

    return NextResponse.json({ favorited: false, message: "Removed from favorites" });
  } catch (error) {
    await logError(db, { message: "Error removing favorite", error, source: "api/favorites", request });
    return NextResponse.json(
      { error: "Failed to remove favorite" },
      { status: 500 }
    );
  }
}
