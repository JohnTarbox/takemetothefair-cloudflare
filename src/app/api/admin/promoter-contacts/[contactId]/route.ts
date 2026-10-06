export const dynamic = "force-dynamic";
/**
 * OPE-1330 — change a promoter contact's status from the admin promoter page.
 * Audit-logged with the reason. ⚠️ Personal contact data: ADMIN ONLY.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { withAuth } from "@/lib/api/with-auth";
import { adminActions, promoterContacts, PROMOTER_CONTACT_STATUSES } from "@/lib/db/schema";
import { validateRequestBody } from "@/lib/validations";

const bodySchema = z.object({
  status: z.enum(PROMOTER_CONTACT_STATUSES),
  reason: z.string().trim().min(1).max(500),
});

export const PATCH = withAuth<{ contactId: string }>(
  { role: "ADMIN" },
  async ({ request, db, session, params }) => {
    const validation = await validateRequestBody(request, bodySchema);
    if (!validation.success) return NextResponse.json({ error: validation.error }, { status: 400 });
    const { status, reason } = validation.data;

    const [c] = await db
      .select()
      .from(promoterContacts)
      .where(eq(promoterContacts.id, params.contactId))
      .limit(1);
    if (!c) return NextResponse.json({ error: "Contact not found" }, { status: 404 });
    if (c.status === status) return NextResponse.json({ changed: false, contact: c });

    const now = new Date();
    const actor = session.user?.id ?? null;
    await db
      .update(promoterContacts)
      .set({
        status,
        ...(status === "validated" && !c.firstValidatedAt ? { firstValidatedAt: now } : {}),
        updatedBy: actor ?? "admin",
        updatedAt: now,
      })
      .where(eq(promoterContacts.id, c.id));
    await db.insert(adminActions).values({
      id: crypto.randomUUID(),
      action: "promoter_contact.status_set",
      actorUserId: actor,
      targetType: "promoter_contact",
      targetId: c.id,
      payloadJson: JSON.stringify({ promoterId: c.promoterId, from: c.status, to: status, reason }),
      createdAt: now,
    });
    const [row] = await db
      .select()
      .from(promoterContacts)
      .where(eq(promoterContacts.id, c.id))
      .limit(1);
    return NextResponse.json({ changed: true, contact: row });
  }
);
