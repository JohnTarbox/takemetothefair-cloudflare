/**
 * The Credentials provider's `authorize`, with its dependencies injected so the
 * order of operations — above all, OPE-935's rule that a throttled attempt
 * never reaches `verifyPassword` — is testable. `src/lib/auth.ts` supplies the
 * real implementations; behaviour is otherwise unchanged from the inline body
 * it replaced.
 */
import { isPlaceholderEmail, PLACEHOLDER_REFUSAL } from "@/lib/auth/placeholder-account";
import { normalizeEmail } from "@/lib/auth/normalize-email";
import type { SignInThrottleResult } from "@/lib/auth/signin-throttle";

type UserRole = "ADMIN" | "PROMOTER" | "VENDOR" | "USER";

export interface CredentialsUser {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  role: string;
  passwordHash: string | null;
}

export interface CredentialsAuthorizeDeps {
  throttle: (request: Request | undefined, email: string) => Promise<SignInThrottleResult>;
  findUserByEmail: (normalizedEmail: string) => Promise<CredentialsUser | undefined>;
  verifyPassword: (password: string, storedHash: string) => Promise<boolean>;
  onRefusedByThrottle: (result: SignInThrottleResult, request: Request | undefined) => void;
  logAuthError: (error: unknown, email: string) => Promise<void>;
}

export async function authorizeCredentials(
  credentials: Partial<Record<"email" | "password", unknown>> | undefined,
  request: Request | undefined,
  deps: CredentialsAuthorizeDeps
): Promise<{
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  role: UserRole;
} | null> {
  if (!credentials?.email || !credentials?.password) {
    return null;
  }
  const email = credentials.email as string;
  const password = credentials.password as string;

  // OPE-293 — an ingestion placeholder never logs in. Redundant today
  // (0 of 6,824 hold a password_hash, so the `!user.passwordHash` check
  // below already refuses them) and deliberately kept anyway: the
  // password-reset path is what would mint that hash, and a guard that
  // only works while a second guard holds is not a guard.
  if (isPlaceholderEmail(email)) {
    console.warn(`[auth] credentials refused — ${PLACEHOLDER_REFUSAL}`);
    return null;
  }

  // OPE-935 — throttle BEFORE the user lookup and the password check. A refused
  // attempt returns exactly what a wrong password returns (null → the normal
  // "invalid credentials" error), so the response never reveals whether the
  // email exists or that the limit, rather than the password, said no.
  const throttle = await deps.throttle(request, email);
  if (!throttle.allowed) {
    deps.onRefusedByThrottle(throttle, request);
    return null;
  }

  try {
    // OPE-601 — the identity key is case-insensitive.
    //
    // This lookup was the worse half of that bug: it locks people out of
    // accounts they already own. Jan Merrill reset her password
    // successfully on 2026-08-07 (that route folds case), then could not
    // sign in as `Admin@kewlkandylz.com`, and registered again 48 minutes
    // later — which 500'd on her own vendor slug.
    const user = await deps.findUserByEmail(normalizeEmail(email));

    if (!user || !user.passwordHash) {
      return null;
    }

    const isValid = await deps.verifyPassword(password, user.passwordHash);
    if (!isValid) {
      return null;
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      image: user.image,
      role: user.role as UserRole,
    };
  } catch (error) {
    await deps.logAuthError(error, email);
    return null;
  }
}
