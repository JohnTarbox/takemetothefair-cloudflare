/**
 * OPE-116 (3/3) — performer claim approval core (approvePerformerClaim).
 *
 *   - grants ownership (claimed + user_id) + audit row
 *   - idempotent for the same user
 *   - refuses a claim held by a DIFFERENT user (no silent takeover)
 *   - not_found guards
 */
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./setup-db.js";
import { performers, adminActions } from "../src/schema.js";
import { approvePerformerClaim } from "../src/tools/performer-claim-approval.js";
import Database from "better-sqlite3";

function seedUser(raw: Database.Database, id: string, email: string) {
  raw
    .prepare("INSERT INTO users (id, email, name, role) VALUES (?,?,?,?)")
    .run(id, email, email.split("@")[0], "USER");
}

async function seedPerformer(
  db: ReturnType<typeof createTestDb>["db"],
  id: string,
  over: Record<string, unknown> = {}
) {
  await db
    .insert(performers)
    .values({ id, name: `Act ${id}`, slug: `slug-${id}`, ...over } as never)
    .run();
}

describe("approvePerformerClaim", () => {
  it("grants ownership + writes an audit row", async () => {
    const { db, raw } = createTestDb();
    seedUser(raw, "u1", "owner@example.com");
    await seedPerformer(db, "p1");

    const res = await approvePerformerClaim(db, {
      performerId: "p1",
      userId: "u1",
      actorUserId: "admin1",
      reason: "verified via business docs",
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.wasAlreadyClaimed).toBe(false);
      expect(res.grantedTo.email).toBe("owner@example.com");
    }
    const [p] = await db.select().from(performers).where(eq(performers.id, "p1"));
    expect(p.claimed).toBe(true);
    expect(p.userId).toBe("u1");
    expect(p.claimedBy).toBe("u1");
    const audits = await db
      .select()
      .from(adminActions)
      .where(eq(adminActions.action, "performer.claim.approve"));
    expect(audits).toHaveLength(1);
  });

  it("is idempotent for the same user (wasAlreadyClaimed=true)", async () => {
    const { db, raw } = createTestDb();
    seedUser(raw, "u1", "owner@example.com");
    await seedPerformer(db, "p1");

    await approvePerformerClaim(db, { performerId: "p1", userId: "u1", actorUserId: "a" });
    const res2 = await approvePerformerClaim(db, {
      performerId: "p1",
      userId: "u1",
      actorUserId: "a",
    });
    expect(res2.ok).toBe(true);
    if (res2.ok) expect(res2.wasAlreadyClaimed).toBe(true);
  });

  it("refuses a claim held by a DIFFERENT user (no silent takeover)", async () => {
    const { db, raw } = createTestDb();
    seedUser(raw, "u1", "a@example.com");
    seedUser(raw, "u2", "b@example.com");
    await seedPerformer(db, "p1", { userId: "u1", claimed: true, claimedBy: "u1" });

    const res = await approvePerformerClaim(db, {
      performerId: "p1",
      userId: "u2",
      actorUserId: "admin1",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("already_claimed_by_different_user");
      expect(res.currentOwnerUserId).toBe("u1");
    }
    // Ownership untouched.
    const [p] = await db.select().from(performers).where(eq(performers.id, "p1"));
    expect(p.userId).toBe("u1");
  });

  it("guards not_found for missing performer / user", async () => {
    const { db, raw } = createTestDb();
    seedUser(raw, "u1", "a@example.com");
    await seedPerformer(db, "p1");

    const noPerf = await approvePerformerClaim(db, {
      performerId: "missing",
      userId: "u1",
      actorUserId: "a",
    });
    expect(noPerf.ok).toBe(false);
    if (!noPerf.ok) expect(noPerf.error).toBe("performer_not_found");

    const noUser = await approvePerformerClaim(db, {
      performerId: "p1",
      userId: "missing",
      actorUserId: "a",
    });
    expect(noUser.ok).toBe(false);
    if (!noUser.ok) expect(noUser.error).toBe("user_not_found");
  });
});
