import { eq } from "drizzle-orm";
import { users, vendors, promoters } from "../schema.js";
import type { Db } from "../db.js";

export type UserProps = {
  userId: string;
  email: string;
  name: string;
  role: "ADMIN" | "PROMOTER" | "VENDOR" | "USER";
  vendorId?: string;
  promoterId?: string;
};

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

async function verifyPbkdf2(
  password: string,
  saltHex: string,
  hashHex: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const salt = fromHex(saltHex);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: 100_000, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return toHex(derivedBits) === hashHex;
}

async function verifySha256(
  password: string,
  storedHash: string,
): Promise<boolean> {
  const data = new TextEncoder().encode(password);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return toHex(hash) === storedHash;
}

/** Verify a password against a stored hash (PBKDF2 or legacy SHA-256). */
export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  if (storedHash.includes(":")) {
    const [saltHex, hashHex] = storedHash.split(":");
    return verifyPbkdf2(password, saltHex, hashHex);
  }
  return verifySha256(password, storedHash);
}

/** Look up a user by email, returning the fields needed for login. */
export async function lookupUser(
  db: Db,
  email: string,
): Promise<{
  id: string;
  email: string;
  name: string | null;
  role: string;
  passwordHash: string | null;
} | null> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      passwordHash: users.passwordHash,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  return rows.length > 0 ? rows[0] : null;
}

/** Resolve vendor/promoter IDs for a user to build the full OAuth props. */
export async function resolveUserProps(
  db: Db,
  user: { id: string; email: string; name: string | null; role: string },
): Promise<UserProps> {
  const props: UserProps = {
    userId: user.id,
    email: user.email,
    name: user.name || "",
    role: user.role as UserProps["role"],
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
