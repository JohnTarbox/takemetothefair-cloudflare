import Link from "next/link";
import { CheckCircle2, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { getCloudflareDb } from "@/lib/cloudflare";
import { validateAndConsumeVerificationToken } from "@/lib/email/verify-token";

export const runtime = "edge";
export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ token: string }>;
}

export default async function VerifyEmailPage({ params }: Props) {
  const { token } = await params;
  const db = getCloudflareDb();
  const result = await validateAndConsumeVerificationToken(db, token);

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
          <h1 className="text-2xl font-bold text-center text-gray-900">
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
              <p className="text-gray-600">
                Thanks for confirming <strong>{result.email}</strong>. You&apos;re all set.
              </p>
              <Link
                href="/dashboard"
                className="inline-block px-5 py-2.5 bg-amber text-navy font-semibold rounded-lg hover:bg-amber-dark transition-colors"
              >
                Go to dashboard
              </Link>
            </div>
          ) : (
            <div className="space-y-4 text-center">
              <p className="text-gray-600">
                {result.reason === "expired"
                  ? "This verification link has expired. Links are valid for 24 hours."
                  : "This verification link isn't valid. It may have already been used."}
              </p>
              <p className="text-sm text-gray-500">
                Sign in and request a new verification email from the banner at the top of the page.
              </p>
              <Link
                href="/login"
                className="inline-block text-sm text-navy hover:underline font-medium"
              >
                Go to sign in
              </Link>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
