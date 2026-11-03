import { eq } from "drizzle-orm";
import { hashPasswordPbkdf2, verifyPasswordHash } from "@takemetothefair/utils";
import { users, vendors, promoters } from "../schema.js";
import type { Db } from "../db.js";

export type UserProps = {
  userId: string;
  email: string;
  name: string;
  role: "ADMIN" | "PROMOTER" | "VENDOR" | "USER";
  vendorId?: string;
  promoterId?: string;
  /**
   * OPE-1366 — users.session_version when these props were resolved. The
   * refresh-time check (token-exchange.ts) refuses the grant once the row's
   * value moves past it. Absent on grants minted before OPE-1366 (= 0).
   */
  sessionVersion?: number;
};

/**
 * OPE-902 — both Workers verify against the same `users.password_hash`, so they
 * share one implementation (`@takemetothefair/utils/password-hash`). This file's
 * own copy had drifted from the main app's: its legacy branch hashed `password`
 * where the app hashed `password + AUTH_SECRET`, so a legacy row could verify at
 * one door and not the other. 0 of 177 password rows were legacy on prod
 * (2026-09-16), so the legacy branch — and the upgrade-on-login that only ever
 * reached rows this door could already verify — are removed.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  return verifyPasswordHash(password, storedHash);
}

export { hashPasswordPbkdf2 };

/** Look up a user by email, returning the fields needed for login. */
export async function lookupUser(
  db: Db,
  email: string
): Promise<{
  id: string;
  email: string;
  name: string | null;
  role: string;
  passwordHash: string | null;
  sessionVersion: number;
} | null> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      passwordHash: users.passwordHash,
      sessionVersion: users.sessionVersion,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  return rows.length > 0 ? rows[0] : null;
}

/** OPE-1366 — the refresh-time re-read: the same fields as `lookupUser`, by id. */
export async function lookupUserById(
  db: Db,
  userId: string
): Promise<{
  id: string;
  email: string;
  name: string | null;
  role: string;
  sessionVersion: number;
} | null> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      sessionVersion: users.sessionVersion,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows.length > 0 ? rows[0] : null;
}

/** Resolve vendor/promoter IDs for a user to build the full OAuth props. */
export async function resolveUserProps(
  db: Db,
  user: { id: string; email: string; name: string | null; role: string; sessionVersion: number }
): Promise<UserProps> {
  const props: UserProps = {
    userId: user.id,
    email: user.email,
    name: user.name || "",
    role: user.role as UserProps["role"],
    sessionVersion: user.sessionVersion,
  };

  if (user.role === "VENDOR" || user.role === "ADMIN") {
    const vendorRows = await db
      .select({ id: vendors.id })
      .from(vendors)
      .where(eq(vendors.userId, user.id))
      .limit(1);
    if (vendorRows.length > 0) props.vendorId = vendorRows[0].id;
  }

  if (user.role === "PROMOTER" || user.role === "ADMIN") {
    const promoterRows = await db
      .select({ id: promoters.id })
      .from(promoters)
      .where(eq(promoters.userId, user.id))
      .limit(1);
    if (promoterRows.length > 0) props.promoterId = promoterRows[0].id;
  }

  return props;
}
