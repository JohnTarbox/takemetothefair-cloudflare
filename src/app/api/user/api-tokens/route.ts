import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { apiTokens } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

export const runtime = "edge";

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return toHex(hash);
}

/** Generate a random API token: "mmatf_" prefix + 40 hex chars */
function generateRawToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return `mmatf_${toHex(bytes.buffer)}`;
}

/** GET — list all tokens for the current user (hashes are NOT returned) */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getCloudflareDb();
  const tokens = await db
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      lastUsedAt: apiTokens.lastUsedAt,
      createdAt: apiTokens.createdAt,
    })
    .from(apiTokens)
    .where(eq(apiTokens.userId, session.user.id));

  return NextResponse.json(tokens);
}

/** POST — create a new API token. Returns the raw token ONCE. */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getCloudflareDb();

  // Limit to 5 tokens per user
  const existing = await db
    .select({ id: apiTokens.id })
    .from(apiTokens)
    .where(eq(apiTokens.userId, session.user.id));

  if (existing.length >= 5) {
    return NextResponse.json(
      { error: "Maximum of 5 API tokens allowed. Please revoke an existing token first." },
      { status: 400 },
    );
  }

  let name = "Default";
  try {
    const body = await request.json() as Record<string, unknown>;
    if (body.name && typeof body.name === "string") {
      name = body.name.slice(0, 50);
    }
  } catch {
    // Body is optional
  }

  const rawToken = generateRawToken();
  const tokenHash = await hashToken(rawToken);
  const id = crypto.randomUUID();

  await db.insert(apiTokens).values({
    id,
    userId: session.user.id,
    tokenHash,
    name,
  });

  return NextResponse.json({
    id,
    name,
    token: rawToken, // Shown once, never stored
  }, { status: 201 });
}

/** DELETE — revoke a token by ID */
export async function DELETE(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const tokenId = searchParams.get("id");

  if (!tokenId) {
    return NextResponse.json({ error: "Token ID required" }, { status: 400 });
  }

  const db = getCloudflareDb();

  // Verify the token exists and belongs to this user before deleting
  const existing = await db
    .select({ id: apiTokens.id })
    .from(apiTokens)
    .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, session.user.id)))
    .limit(1);

  if (existing.length === 0) {
    return NextResponse.json({ error: "Token not found" }, { status: 404 });
  }

  await db.delete(apiTokens).where(eq(apiTokens.id, tokenId));

  return NextResponse.json({ deleted: true });
}
