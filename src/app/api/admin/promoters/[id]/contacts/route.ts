export const dynamic = "force-dynamic";
/**
 * OPE-1330 — a promoter's contacts, for the admin promoter page.
 * ⚠️ Personal contact data: ADMIN ONLY (withAuth role gate).
 */
import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { withAuth } from "@/lib/api/with-auth";
import { promoterContacts } from "@/lib/db/schema";

export const GET = withAuth<{ id: string }>({ role: "ADMIN" }, async ({ db, params }) => {
  const contacts = await db
    .select()
    .from(promoterContacts)
    .where(eq(promoterContacts.promoterId, params.id))
    .orderBy(desc(promoterContacts.updatedAt));
  return NextResponse.json({ contacts });
});
