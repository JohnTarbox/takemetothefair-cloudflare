import Link from "next/link";
import { cookies } from "next/headers";
import { CheckCircle2, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { getCloudflareDb } from "@/lib/cloudflare";
import { validateAndConsumeVerificationToken } from "@/lib/email/verify-token";
import { parseGaClientId } from "@/lib/ga4-measurement-protocol";
import { trackClaimCompletedServer } from "@/lib/analytics/claim-funnel";
import { ResendVerificationButton } from "@/components/auth/ResendVerificationButton";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ token: string }>;
}

export default async function VerifyEmailPage({ params }: Props) {
  const { token } = await params;
  const db = getCloudflareDb();
  const result = await validateAndConsumeVerificationToken(db, token);

  // OPE-66 — a verified email that auto-approved rung-1 (email-match) claims
  // completes the claim funnel. Fire claim_completed_server (ad-block-proof)
  // with the user's GA client_id from the `_ga` cookie. The token is single-use
  // (consumed above), so a page refresh returns not_found → no double-count.
  if (result.ok && result.approvedClaims.length > 0) {
    const gaValue = (await cookies()).get("_ga")?.value;
    const clientId = parseGaClientId(gaValue ? `_ga=${gaValue}` : null) ?? crypto.randomUUID();
    for (const c of result.approvedClaims) {
      await trackClaimCompletedServer({
        clientId,
        entityType: c.entityType,
        entitySlug: c.entitySlug,
        method: "EMAIL_MATCH",
      });
    }
  }

  return (
    <div className="min-h-[80vh] flex items-center justify-center px-4 py-12">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex justify-center mb-3">
            {result.ok ? (
              <CheckCircle2 className="w-12 h-12 text-sage-700" />
            ) : (
              <AlertTriangle className="w-12 h-12 text-warning" />
            )}
          </div>
          <h1 className="text-2xl font-bold text-center text-foreground">
            {result.ok
              ? "Email verified"
              : result.reason === "expired"
                ? "Link expired"
                : "Invalid verification link"}
          </h1>
        </CardHeader>
        <CardContent>
          {result.ok ? (
            <div className="space-y-4 text-center">
              <p className="text-muted-foreground">
                Thanks for confirming <strong>{result.email}</strong>. You&apos;re all set.
              </p>
              <Link
                href="/dashboard"
                className="inline-block px-5 py-2.5 bg-amber text-primary-foreground font-semibold rounded-lg hover:bg-amber-dark transition-colors"
              >
                Go to dashboard
              </Link>
            </div>
          ) : (
            <div className="space-y-4 text-center">
              <p className="text-muted-foreground">
                {result.reason === "expired"
                  ? "This verification link has expired. Links are valid for 24 hours."
                  : "This verification link isn't valid. It may have already been used."}
              </p>
              <p className="text-sm text-muted-foreground">
                Enter the email you signed up with — we&apos;ll send a fresh link.
              </p>
              <div className="flex justify-center">
                <ResendVerificationButton label="Send a new link" />
              </div>
              <p className="text-sm text-muted-foreground pt-2">
                Already verified?{" "}
                <Link href="/login" className="text-navy hover:underline font-medium">
                  Sign in
                </Link>
                .
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
