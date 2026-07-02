/**
 * OPE-63 — promoter claim-approval core (approvePromoterClaim).
 *
 * Same in-memory SQLite harness as the other MCP core suites. Exercises the
 * end-to-end happy path, the no-overwrite invariant (claim by a different user
 * is refused), and same-user idempotency.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq, and } from "drizzle-orm";
import { unsafeSlug } from "@takemetothefair/utils";
import { createTestDb, type TestDb } from "./setup-db.js";
import { approvePromoterClaim } from "../src/tools/promoter-claim-approval.js";
import { promoters, users, userRoles, adminActions } from "../src/schema.js";

const ACTOR = "u-admin";

let db: TestDb;

beforeEach(() => {
  ({ db } = createTestDb());
  db.insert(users).values({ id: ACTOR, email: "admin@test", role: "ADMIN" }).run();
});

function seedUser(id: string) {
  db.insert(users)
    .values({ id, email: `${id}@test`, role: "USER" })
    .run();
  return id;
}

function seedPromoter(id: string, overrides: Partial<typeof promoters.$inferInsert> = {}) {
  db.insert(promoters)
    .values({
      id,
      companyName: overrides.companyName ?? `Promoter ${id}`,
      slug: unsafeSlug(overrides.slug ?? `promoter-${id}`),
      ...overrides,
    })
    .run();
  return id;
}

async function readPromoter(id: string) {
  const [row] = await db.select().from(promoters).where(eq(promoters.id, id)).limit(1);
  return row;
}

describe("approvePromoterClaim (OPE-63)", () => {
  it("claims a promoter end-to-end: flips claimed, links user, grants role, audits", async () => {
    seedUser("u-owner");
    seedPromoter("p-1");

    const result = await approvePromoterClaim(db, {
      promoterId: "p-1",
      userId: "u-owner",
      actorUserId: ACTOR,
      reason: "verified via registration docs",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.wasAlreadyClaimed).toBe(false);
    expect(result.grantedRole).toBe("PROMOTER");

    const promoter = await readPromoter("p-1");
    expect(promoter.claimed).toBe(true);
    expect(promoter.claimedBy).toBe("u-owner");
    expect(promoter.userId).toBe("u-owner");
    expect(promoter.claimedAt).toBeInstanceOf(Date);

    const roles = await db
      .select()
      .from(userRoles)
      .where(and(eq(userRoles.userId, "u-owner"), eq(userRoles.role, "PROMOTER")));
    expect(roles).toHaveLength(1);

    const audits = await db
      .select()
      .from(adminActions)
      .where(eq(adminActions.action, "promoter.claim.approve"));
    expect(audits).toHaveLength(1);
    expect(audits[0].targetId).toBe("p-1");
    expect(audits[0].actorUserId).toBe(ACTOR);
  });

  it("refuses to overwrite a claim held by a DIFFERENT user (no-overwrite invariant)", async () => {
    seedUser("u-owner");
    seedUser("u-intruder");
    seedPromoter("p-1");

    // First user claims.
    const first = await approvePromoterClaim(db, {
      promoterId: "p-1",
      userId: "u-owner",
      actorUserId: ACTOR,
    });
    expect(first.ok).toBe(true);

    // Second, different user is refused.
    const second = await approvePromoterClaim(db, {
      promoterId: "p-1",
      userId: "u-intruder",
      actorUserId: ACTOR,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toBe("already_claimed_by_different_user");
    expect(second.currentOwnerUserId).toBe("u-owner");

    // Ownership unchanged; no PROMOTER role for the intruder.
    const promoter = await readPromoter("p-1");
    expect(promoter.claimedBy).toBe("u-owner");
    expect(promoter.userId).toBe("u-owner");
    const intruderRoles = await db
      .select()
      .from(userRoles)
      .where(and(eq(userRoles.userId, "u-intruder"), eq(userRoles.role, "PROMOTER")));
    expect(intruderRoles).toHaveLength(0);
  });

  it("is idempotent for a repeat claim by the SAME user (no duplicate role row)", async () => {
    seedUser("u-owner");
    seedPromoter("p-1");

    await approvePromoterClaim(db, { promoterId: "p-1", userId: "u-owner", actorUserId: ACTOR });
    const repeat = await approvePromoterClaim(db, {
      promoterId: "p-1",
      userId: "u-owner",
      actorUserId: ACTOR,
    });

    expect(repeat.ok).toBe(true);
    if (!repeat.ok) return;
    expect(repeat.wasAlreadyClaimed).toBe(true);

    // Exactly one PROMOTER role row (onConflictDoNothing), still claimed.
    const roles = await db
      .select()
      .from(userRoles)
      .where(and(eq(userRoles.userId, "u-owner"), eq(userRoles.role, "PROMOTER")));
    expect(roles).toHaveLength(1);

    const promoter = await readPromoter("p-1");
    expect(promoter.claimed).toBe(true);
    expect(promoter.claimedBy).toBe("u-owner");
  });

  it("returns promoter_not_found / user_not_found for missing rows", async () => {
    seedUser("u-owner");
    const noPromoter = await approvePromoterClaim(db, {
      promoterId: "missing",
      userId: "u-owner",
      actorUserId: ACTOR,
    });
    expect(noPromoter).toMatchObject({ ok: false, error: "promoter_not_found" });

    seedPromoter("p-1");
    const noUser = await approvePromoterClaim(db, {
      promoterId: "p-1",
      userId: "missing",
      actorUserId: ACTOR,
    });
    expect(noUser).toMatchObject({ ok: false, error: "user_not_found" });
  });
});
