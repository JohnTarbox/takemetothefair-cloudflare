import NextAuth from "next-auth";
import type { JWT } from "next-auth/jwt";
import type { Session, User, NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import Facebook from "next-auth/providers/facebook";
import { isPlaceholderEmail, PLACEHOLDER_REFUSAL } from "@/lib/auth/placeholder-account";
import { normalizeEmail } from "@/lib/auth/normalize-email";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getCloudflareDb, type CloudflareStringEnvKey } from "./cloudflare";
import * as schema from "./db/schema";
import { eq, and } from "drizzle-orm";
import { logError } from "./logger";
import { authorizeCredentials } from "@/lib/auth/credentials-authorize";
import { signInThrottle, type SignInThrottleResult } from "@/lib/auth/signin-throttle";
import { getBurstLimiter } from "@/lib/burst-limiter";

type UserRole = "ADMIN" | "PROMOTER" | "VENDOR" | "USER";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email: string;
      name?: string | null;
      image?: string | null;
      /**
       * Primary role — back-compat with the ~100 existing callers that
       * do `session.user.role === X` checks. Reads from `users.role`.
       * PR 2 will sweep these to use `roles` + hasRole().
       */
      role: UserRole;
      /**
       * All granted roles. Source of truth is the `user_roles` table.
       * Always contains at least the primary role (backfilled in
       * drizzle/0089). Dual-role users have multiple entries.
       */
      roles: UserRole[];
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
    roles: UserRole[];
  }
}

/**
 * Check whether the signed-in user has been granted a particular role.
 * Reads from the array side (user_roles) so dual-role users are honored.
 * Returns false on an unauthenticated session.
 *
 * Use this for any new gate/UI check. Existing callers using
 * `session.user.role === X` keep working off the primary role and will
 * be migrated in PR 2.
 */
export function hasRole(
  session: { user?: { roles?: readonly UserRole[] } } | null | undefined,
  role: UserRole
): boolean {
  return !!session?.user?.roles?.includes(role);
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
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
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
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return toHex(derivedBits) === hashHex;
}

// Legacy SHA-256 verification for backward compatibility
async function verifyLegacySha256(password: string, storedHash: string): Promise<boolean> {
  const secret = getRuntimeEnv("AUTH_SECRET");
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

/**
 * OPE-935 — a refused sign-in is a security event, so it is recorded; but the
 * refusal path is exactly what an attacker drives in volume, so the record is
 * itself budgeted (5 per 60 s, one shared key) and handed to `waitUntil` so it
 * never delays or fails the response. The same shape OPE-902 uses for refused
 * internal keys. The IP is not stored — only which budget refused.
 */
function scheduleSignInRefusalRecord(result: SignInThrottleResult, request: Request | undefined) {
  const work = (async () => {
    const limiter = getBurstLimiter();
    if (!limiter || !(await limiter.limit({ key: "auth-signin-refusal-log" })).success) return;
    await logError(getCloudflareDb(), {
      level: "warn",
      source: "auth:signin-throttled",
      message: `sign-in refused by the burst cap (${result.reason})`,
      context: { reason: result.reason, path: request ? new URL(request.url).pathname : null },
    });
  })().catch(() => {});
  try {
    getCloudflareContext().ctx.waitUntil(work);
  } catch {
    // No request context (tests, local dev): the promise still runs.
  }
}

// Read env vars at runtime from Cloudflare Pages env
// (process.env values are inlined at build time and won't have production secrets)
function getRuntimeEnv(key: CloudflareStringEnvKey): string | undefined {
  try {
    const { env } = getCloudflareContext();
    return env[key];
  } catch {
    return process.env[key];
  }
}

// Create NextAuth config lazily so Google credentials are read at runtime
function createAuthConfig(): NextAuthConfig {
  const googleClientId = getRuntimeEnv("GOOGLE_CLIENT_ID");
  const googleClientSecret = getRuntimeEnv("GOOGLE_CLIENT_SECRET");

  const providers: NextAuthConfig["providers"] = [
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      // OPE-935 — body extracted to `authorizeCredentials` so the throttle-before-
      // password ordering is testable. `request` is Auth.js's second argument.
      async authorize(credentials, request) {
        const db = getCloudflareDb();
        return authorizeCredentials(credentials, request, {
          throttle: signInThrottle,
          findUserByEmail: (email) =>
            db.query.users.findFirst({ where: eq(schema.users.email, email) }),
          verifyPassword,
          hashPassword,
          updatePasswordHash: async (userId, hash) => {
            await db
              .update(schema.users)
              .set({ passwordHash: hash })
              .where(eq(schema.users.id, userId));
          },
          onRefusedByThrottle: scheduleSignInRefusalRecord,
          logAuthError: (error, email) =>
            logError(db, {
              message: "Auth error",
              error,
              source: "lib/auth.ts:authorize",
              context: { email },
            }),
        });
      },
    }),
  ];

  const facebookClientId = getRuntimeEnv("FACEBOOK_CLIENT_ID");
  const facebookClientSecret = getRuntimeEnv("FACEBOOK_CLIENT_SECRET");

  if (facebookClientId && facebookClientSecret) {
    providers.unshift(Facebook({ clientId: facebookClientId, clientSecret: facebookClientSecret }));
  }

  if (googleClientId && googleClientSecret) {
    providers.unshift(Google({ clientId: googleClientId, clientSecret: googleClientSecret }));
  }

  return {
    session: { strategy: "jwt" },
    pages: {
      signIn: "/login",
      error: "/login",
    },
    providers,
    callbacks: {
      async signIn({ user, account, profile }) {
        // Only handle OAuth providers; let credentials pass through
        if (account?.type !== "oidc" && account?.type !== "oauth") {
          return true;
        }
        if (!profile?.email) {
          return true;
        }

        const db = getCloudflareDb();

        // Check if this OAuth account is already linked
        const existingAccount = await db.query.accounts.findFirst({
          where: and(
            eq(schema.accounts.provider, account.provider),
            eq(schema.accounts.providerAccountId, account.providerAccountId)
          ),
        });

        if (existingAccount) {
          // Already linked — look up user to set role
          const dbUser = await db.query.users.findFirst({
            where: eq(schema.users.id, existingAccount.userId),
          });
          if (dbUser) {
            user.id = dbUser.id;
            user.role = dbUser.role as UserRole;
          }
          return true;
        }

        // OPE-293 — refuse BEFORE the email-match lookup below.
        //
        // That lookup links a provider account to any existing user that has no
        // `passwordHash`, and placeholders have none by definition — so they are
        // exactly the rows it would bind to. Refusing here also covers the
        // create branch, so a provider attesting a `pending+…` address cannot
        // mint a fresh account on it either.
        if (isPlaceholderEmail(profile.email)) {
          console.warn(`[auth] OAuth refused — ${PLACEHOLDER_REFUSAL}`);
          return "/login?error=AccessDenied";
        }

        // Check if a user with this email already exists
        const existingUser = await db.query.users.findFirst({
          where: eq(schema.users.email, normalizeEmail(profile.email)),
        });

        if (existingUser && existingUser.passwordHash) {
          // User registered with email/password — block to prevent account takeover
          return "/login?error=OAuthAccountNotLinked";
        }

        // Extract profile image (Google uses "picture", Facebook uses "image")
        const profileImage = (profile.picture as string) ?? (profile.image as string) ?? null;

        if (!existingUser) {
          // Create new user
          const userId = crypto.randomUUID();
          await db.insert(schema.users).values({
            id: userId,
            email: profile.email,
            name: profile.name ?? null,
            image: profileImage,
            role: "USER",
            emailVerified: new Date(),
          });
          // Mirror the primary role into user_roles. userId is freshly
          // generated so no conflict is possible. New OAuth signups
          // start as USER; they pick up additional roles later via
          // email-match self-service claim or admin grant.
          await db.insert(schema.userRoles).values({
            userId,
            role: "USER",
            grantedAt: new Date(),
          });
          await db.insert(schema.accounts).values({
            userId,
            type: "oauth",
            provider: account.provider,
            providerAccountId: account.providerAccountId,
            accessToken: account.access_token ?? null,
            refreshToken: account.refresh_token ?? null,
            expiresAt: account.expires_at ?? null,
            tokenType: account.token_type ?? null,
            scope: account.scope ?? null,
            idToken: account.id_token ?? null,
          });
          user.id = userId;
          user.role = "USER";
        } else {
          // Existing user without password — link new account
          await db.insert(schema.accounts).values({
            userId: existingUser.id,
            type: "oauth",
            provider: account.provider,
            providerAccountId: account.providerAccountId,
            accessToken: account.access_token ?? null,
            refreshToken: account.refresh_token ?? null,
            expiresAt: account.expires_at ?? null,
            tokenType: account.token_type ?? null,
            scope: account.scope ?? null,
            idToken: account.id_token ?? null,
          });
          user.id = existingUser.id;
          user.role = existingUser.role as UserRole;
        }

        return true;
      },
      async jwt({ token, user }: { token: JWT; user?: User }) {
        if (user && user.id) {
          token.id = user.id;
          if (user.role) {
            token.role = user.role;
          } else {
            const db = getCloudflareDb();
            const dbUser = await db.query.users.findFirst({
              where: eq(schema.users.id, user.id),
              columns: { role: true },
            });
            token.role = (dbUser?.role as UserRole) || "USER";
          }
          // Load granted roles from user_roles. Always includes at least
          // the primary role thanks to the drizzle/0089 backfill. The
          // fallback to `[token.role]` covers the (defensive) case where
          // the row is missing — never silently downgrade a user to
          // "no roles."
          try {
            const db = getCloudflareDb();
            const grants = await db
              .select({ role: schema.userRoles.role })
              .from(schema.userRoles)
              .where(eq(schema.userRoles.userId, user.id));
            const roles = grants.map((g) => g.role as UserRole);
            if (!roles.includes(token.role as UserRole)) roles.push(token.role as UserRole);
            token.roles = roles;
          } catch {
            token.roles = [token.role as UserRole];
          }
        }
        return token;
      },
      async session({ session, token }: { session: Session; token: JWT }) {
        if (session.user && token.id) {
          session.user.id = token.id as string;
          session.user.role = token.role as UserRole;
          session.user.roles = (token.roles as UserRole[] | undefined) ?? [token.role as UserRole];
        }
        return session;
      },
    },
    trustHost: true,
  };
}

// Create NextAuth per-request so Cloudflare runtime env vars are available
function initAuth() {
  return NextAuth(createAuthConfig());
}

// Type definitions for NextAuth exports
type NextAuthReturn = ReturnType<typeof NextAuth>;
type HandlersType = NextAuthReturn["handlers"];
type AuthType = NextAuthReturn["auth"];
type SignInType = NextAuthReturn["signIn"];
type SignOutType = NextAuthReturn["signOut"];

// Typed route handlers - lazily initialize NextAuth on each request
export const handlers: HandlersType = {
  GET: (req) => initAuth().handlers.GET(req),
  POST: (req) => initAuth().handlers.POST(req),
};

// Typed auth function with all overloads
export const auth: AuthType = ((...args: Parameters<AuthType>) => {
  const instance = initAuth();
  return (instance.auth as (...args: Parameters<AuthType>) => ReturnType<AuthType>)(...args);
}) as AuthType;

// Typed signIn function
export const signIn: SignInType = ((...args: Parameters<SignInType>) => {
  const instance = initAuth();
  return (instance.signIn as (...args: Parameters<SignInType>) => ReturnType<SignInType>)(...args);
}) as SignInType;

// Typed signOut function
export const signOut: SignOutType = ((...args: Parameters<SignOutType>) => {
  const instance = initAuth();
  return (instance.signOut as (...args: Parameters<SignOutType>) => ReturnType<SignOutType>)(
    ...args
  );
}) as SignOutType;
