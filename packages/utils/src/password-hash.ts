/**
 * OPE-902 — the ONE password hash format and verifier, shared by the main app
 * and the MCP Worker.
 *
 * Both deploy artifacts verify against the same `users.password_hash` column,
 * and each used to carry its own copy of the verifier. The copies had drifted:
 * the main app's legacy branch was SHA-256 of `password + AUTH_SECRET`, the MCP
 * Worker's was SHA-256 of `password` alone — so for any legacy row exactly one
 * of the two doors could verify it — and the main app still compared PBKDF2
 * digests with `===`.
 *
 * Measured on prod D1, 2026-09-16: 177 users hold a password, 177 are PBKDF2
 * `<saltHex>:<hashHex>`, **0 are legacy**. The only remaining writer of a legacy
 * hash was `scripts/seed.ts`, which now uses this module too. So the legacy
 * branches are removed rather than reconciled: an unsalted digest is refused.
 */
import { timingSafeEqualString } from "./timing-safe-equal";

export const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;

function toHex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return bytes;
}

async function derive(password: string, salt: Uint8Array): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return toHex(bits);
}

/** Mint a stored hash in the `<saltHex>:<hashHex>` form. */
export async function hashPasswordPbkdf2(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  return `${toHex(salt)}:${await derive(password, salt)}`;
}

/**
 * Verify a password against a stored `<saltHex>:<hashHex>` hash, comparing the
 * digests in constant time. Anything else — a legacy bare digest, an empty or
 * malformed value — is refused, never guessed at.
 */
export async function verifyPasswordHash(
  password: string,
  storedHash: string | null | undefined
): Promise<boolean> {
  if (!password || !storedHash) return false;
  const parts = storedHash.split(":");
  if (parts.length !== 2) return false;
  const salt = fromHex(parts[0]);
  if (!salt || !fromHex(parts[1])) return false;
  return timingSafeEqualString(await derive(password, salt), parts[1].toLowerCase());
}
