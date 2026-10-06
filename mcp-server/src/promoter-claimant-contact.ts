/**
 * OPE-1330 scope item 5, MCP side — the twin of the main app's
 * `src/lib/claims/promoter-contact.ts` for the one promoter-claim write that
 * lives in this Worker (`approvePromoterClaim`). Same shared rule
 * (`planPromoterContactWrite`), same best-effort contract: a failure is logged
 * and never fails the claim.
 */
import { and, eq } from "drizzle-orm";
import { planPromoterContactWrite } from "@takemetothefair/db-schema";
import type { Db } from "./db.js";
import { adminActions, promoterContacts, users } from "./schema.js";
import { decodeHtmlEntities } from "./helpers.js";

export async function recordClaimantAsPromoterContact(
  db: Db,
  input: { promoterId: string; userId: string; via: "mcp-approve-promoter-claim"; now?: Date }
): Promise<"inserted" | "promoted" | "updated" | "unchanged" | "skipped"> {
  const now = input.now ?? new Date();
  try {
    const [user] = await db
      .select({ email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1);
    if (!user?.email) return "skipped";
    const email = user.email.trim().toLowerCase();
    const [existing] = await db
      .select({
        id: promoterContacts.id,
        status: promoterContacts.status,
        firstValidatedAt: promoterContacts.firstValidatedAt,
        lastHeardAt: promoterContacts.lastHeardAt,
      })
      .from(promoterContacts)
      .where(
        and(eq(promoterContacts.promoterId, input.promoterId), eq(promoterContacts.email, email))
      )
      .limit(1);
    const plan = planPromoterContactWrite({
      writer: "claim",
      existing: existing ?? null,
      promoterId: input.promoterId,
      email,
      fields: {
        name: user.name ? decodeHtmlEntities(user.name).slice(0, 200) : null,
        validationMethod: "approved_claim",
        validationEvidence: `promoter claim approved (${input.via}) for account ${input.userId}`,
        status: "validated",
      },
      actor: `claim:${input.via}`,
      now,
    });
    let id: string;
    let outcome: "inserted" | "promoted" | "updated";
    if (plan.kind === "insert") {
      id = crypto.randomUUID();
      const res = await db
        .insert(promoterContacts)
        .values({ id, ...(plan.values as typeof promoterContacts.$inferInsert) })
        .onConflictDoNothing()
        .returning({ id: promoterContacts.id });
      if (res.length === 0) return "unchanged";
      outcome = "inserted";
    } else if (plan.kind === "update") {
      id = plan.id;
      await db.update(promoterContacts).set(plan.set).where(eq(promoterContacts.id, id));
      outcome = plan.promoted ? "promoted" : "updated";
    } else {
      return plan.kind === "invalid" ? "skipped" : "unchanged";
    }
    if (outcome !== "updated") {
      await db.insert(adminActions).values({
        action: "promoter_contact.claim_validated",
        actorUserId: null,
        targetType: "promoter_contact",
        targetId: id,
        payloadJson: JSON.stringify({
          promoterId: input.promoterId,
          userId: input.userId,
          via: input.via,
          outcome,
        }),
        createdAt: now,
      });
    }
    return outcome;
  } catch {
    return "skipped";
  }
}
