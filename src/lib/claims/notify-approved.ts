/**
 * OPE-64 — best-effort "your claim was approved" in-app notification.
 *
 * Called from the claim approval cores whenever a claim flips to APPROVED
 * (wizard instant-approve, deferred domain-match approval, deferred email-match
 * approval, admin review). BEST-EFFORT by contract: a notifications insert
 * failure must NEVER roll back or throw past the ownership transfer — the claim
 * is already committed. Swallow everything.
 */
import { notifications } from "@/lib/db/schema";
import type { Database } from "@/lib/db";

export async function insertClaimApprovedNotification(
  db: Database,
  args: {
    userId: string;
    entityType: "VENDOR" | "PROMOTER";
    entitySlug: string;
    entityName?: string | null;
  }
): Promise<void> {
  try {
    const name = args.entityName?.trim() || "your listing";
    const portal = args.entityType === "VENDOR" ? "/vendor/profile" : "/promoter/events";
    await db.insert(notifications).values({
      id: crypto.randomUUID(),
      userId: args.userId,
      type: "claim_approved",
      title: "Claim approved",
      message: `You now manage ${name}.`,
      data: JSON.stringify({
        entityType: args.entityType,
        entitySlug: args.entitySlug,
        portal,
      }),
      createdAt: new Date(),
    });
  } catch {
    // Best-effort — the approval is already committed.
  }
}
