import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { users } from "@/lib/db/schema";
import { UnverifiedBannerClient } from "./unverified-banner-client";

/**
 * Server component. Checks whether the signed-in user has verified their
 * email and renders the dismissible client banner if not. Returns null for
 * logged-out users or users already verified.
 */
export async function UnverifiedBanner() {
  const session = await auth();
  if (!session?.user?.email) return null;

  try {
    const db = getCloudflareDb();
    const user = await db.query.users.findFirst({
      where: eq(users.email, session.user.email),
      columns: { emailVerified: true },
    });
    if (!user || user.emailVerified) return null;
  } catch {
    // If the DB lookup fails, don't nag the user with a spurious banner.
    return null;
  }

  return <UnverifiedBannerClient email={session.user.email} />;
}
