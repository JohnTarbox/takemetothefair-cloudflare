/**
 * OPE-1330 scope item 5 — an approved promoter claim makes the claimant a
 * `validated` / `approved_claim` promoter contact.
 *
 * Called right after EVERY write that sets `promoters.claimed = true` (admin
 * review, invite-token redeem, verified-email at signup, the claim wizard,
 * the direct email-match route). A source guard
 * (`promoter-claim-records-contact-ope1330.test.ts`) fails the build if a new
 * claim path writes `claimed: true` on promoters without calling this —
 * keyed on the ACT, so a path that forgets cannot hide.
 *
 * Best-effort by design: the contact record is bookkeeping, the claim is the
 * user's real outcome. A failure here is logged and never fails or rolls back
 * the claim. The write rule is the shared `planPromoterContactWrite` (a row a
 * human rejected is left alone).
 */
import { and, eq } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { adminActions, promoterContacts, users } from "@/lib/db/schema";
import { planPromoterContactWrite } from "@takemetothefair/db-schema";
import { decodeHtmlEntities } from "@/lib/utils";
import { logError } from "@/lib/logger";

export type ClaimContactPath =
  | "admin-review"
  | "invite-token"
  | "signup-email-match"
  | "wizard"
  | "direct-email-match";

export async function recordClaimantAsPromoterContact(
  db: Database,
  input: { promoterId: string; userId: string; via: ClaimContactPath; now?: Date }
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
    let outcome: "inserted" | "promoted" | "updated" | "unchanged";
    if (plan.kind === "invalid") return "skipped";
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
      return "unchanged";
    }
    if (outcome !== "updated") {
      await db.insert(adminActions).values({
        id: crypto.randomUUID(),
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
  } catch (error) {
    await logError(db as never, {
      message: "recording the claimant as a promoter contact failed; the claim itself stands",
      error,
      source: "claims/promoter-contact",
      context: { promoterId: input.promoterId, userId: input.userId, via: input.via },
    }).catch(() => {});
    return "skipped";
  }
}
