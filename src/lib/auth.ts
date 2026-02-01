import NextAuth from "next-auth";
import type { JWT } from "next-auth/jwt";
import type { Session, User, NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { getCloudflareDb } from "./cloudflare";
import * as schema from "./db/schema";
import { eq } from "drizzle-orm";
import { logError } from "./logger";

type UserRole = "ADMIN" | "PROMOTER" | "VENDOR" | "USER";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email: string;
      name?: string | null;
      image?: string | null;
      role: UserRole;
    };
  }

  interface User {
    role: UserRole;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    role: UserRole;
  }
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

// PBKDF2 password hashing for edge runtime (Web Crypto API)
const PBKDF2_ITERATIONS = 100_000;
const SALT_LENGTH = 16; // 16 bytes = 32 hex chars

export async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return `${toHex(salt.buffer)}:${toHex(derivedBits)}`;
}

async function verifyPbkdf2(password: string, saltHex: string, hashHex: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const salt = fromHex(saltHex);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return toHex(derivedBits) === hashHex;
}

// Legacy SHA-256 verification for backward compatibility
async function verifyLegacySha256(password: string, storedHash: string): Promise<boolean> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return false;
  const encoder = new TextEncoder();
  const data = encoder.encode(password + secret);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return toHex(hash) === storedHash;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (storedHash.includes(":")) {
    const [salt, hash] = storedHash.split(":");
    return verifyPbkdf2(password, salt, hash);
  }
  // Legacy format: plain SHA-256 hex
  return verifyLegacySha256(password, storedHash);
}

// Create NextAuth config
const authConfig: NextAuthConfig = {
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
    error: "/login",
  },
  adapter: DrizzleAdapter(getCloudflareDb(), {
    usersTable: schema.users,
    accountsTable: schema.accounts,
    sessionsTable: schema.sessions,
    verificationTokensTable: schema.verificationTokens,
  }),
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    }),
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          return null;
        }

        const db = getCloudflareDb();

        try {

          const user = await db.query.users.findFirst({
            where: eq(schema.users.email, credentials.email as string),
          });

          if (!user || !user.passwordHash) {
            return null;
          }

          const isValid = await verifyPassword(
            credentials.password as string,
            user.passwordHash
          );

          if (!isValid) {
            return null;
          }

          // Re-hash legacy SHA-256 passwords to PBKDF2 on successful login
          if (!user.passwordHash.includes(":")) {
            try {
              const newHash = await hashPassword(credentials.password as string);
              await db
                .update(schema.users)
                .set({ passwordHash: newHash })
                .where(eq(schema.users.id, user.id));
            } catch {
              // Non-fatal: login still succeeds even if re-hash fails
            }
          }

          return {
            id: user.id,
            email: user.email,
            name: user.name,
            image: user.image,
            role: user.role as UserRole,
          };
        } catch (error) {
          await logError(db, {
            message: "Auth error",
            error,
            source: "lib/auth.ts:authorize",
            context: { email: credentials.email },
          });
          return null;
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }: { token: JWT; user?: User }) {
      if (user && user.id) {
        token.id = user.id;
        // For OAuth users, user.role may not be set by authorize()
        if (user.role) {
          token.role = user.role;
        } else {
          // Look up role from DB
          const db = getCloudflareDb();
          const dbUser = await db.query.users.findFirst({
            where: eq(schema.users.id, user.id),
            columns: { role: true },
          });
          token.role = (dbUser?.role as UserRole) || "USER";
        }
      }
      return token;
    },
    async session({ session, token }: { session: Session; token: JWT }) {
      if (session.user && token.id) {
        session.user.id = token.id as string;
        session.user.role = token.role as UserRole;
      }
      return session;
    },
  },
  trustHost: true,
};

const { handlers, auth, signIn, signOut } = NextAuth(authConfig);

export { handlers, auth, signIn, signOut };
