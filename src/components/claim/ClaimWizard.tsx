"use client";

import { useState } from "react";
import Link from "next/link";
import { CheckCircle2, AlertCircle, Mail, ArrowRight, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ClaimEvidenceForm } from "@/components/claim/ClaimEvidenceForm";

type EntityType = "VENDOR" | "PROMOTER";

type Outcome =
  | "approved"
  | "pending_verification"
  | "needs_evidence"
  | "already_yours"
  | "already_claimed";

interface WizardResult {
  outcome: Outcome;
  method: "EMAIL_MATCH" | "DOMAIN_MATCH" | "EVIDENCE" | null;
  entityName: string | null;
  entitySlug: string;
}

interface Props {
  entityType: EntityType;
  slug: string;
  entityName: string;
  /** Vendors expose viewCount; promoters do not (null → omit the stat). */
  viewCount: number | null;
  linkedEventsCount: number;
  isLoggedIn: boolean;
  registerHref: string;
  loginHref: string;
}

const STEPS = ["Preview", "Account", "Verify"] as const;

export function ClaimWizard({
  entityType,
  slug,
  entityName,
  viewCount,
  linkedEventsCount,
  isLoggedIn,
  registerHref,
  loginHref,
}: Props) {
  // Start on the account step once signed in; otherwise begin at the preview.
  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<WizardResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const portalHref = entityType === "VENDOR" ? "/vendor/profile" : "/promoter/events";
  const kind = entityType === "VENDOR" ? "listing" : "organization";

  async function submitClaim() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/claim/wizard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityType, slug }),
      });
      if (res.status === 429) {
        setError("Too many attempts. Please wait a little while and try again.");
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Something went wrong. Please try again.");
        return;
      }
      const body = (await res.json()) as WizardResult;
      setResult(body);
    } catch (e) {
      setError(`Network error: ${(e as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Stepper */}
      <ol className="flex items-center gap-2 text-sm" aria-label="Progress">
        {STEPS.map((label, i) => {
          const active = i === step;
          const done = i < step;
          return (
            <li key={label} className="flex items-center gap-2">
              <span
                className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${
                  active
                    ? "bg-navy text-white"
                    : done
                      ? "bg-sage-600 text-white"
                      : "bg-stone-200 text-stone-600"
                }`}
                aria-current={active ? "step" : undefined}
              >
                {done ? "✓" : i + 1}
              </span>
              <span className={active ? "font-medium text-foreground" : "text-muted-foreground"}>
                {label}
              </span>
              {i < STEPS.length - 1 && <span className="text-stone-300">—</span>}
            </li>
          );
        })}
      </ol>

      {/* Step 0 — Preview */}
      {step === 0 && (
        <Card>
          <CardContent className="p-6 space-y-4">
            <div>
              <h2 className="text-lg font-semibold text-foreground">{entityName}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {viewCount !== null && (
                  <span>
                    Viewed {viewCount.toLocaleString()} time{viewCount === 1 ? "" : "s"}
                    {linkedEventsCount > 0 ? " · " : ""}
                  </span>
                )}
                {linkedEventsCount > 0 && (
                  <span>
                    {linkedEventsCount} linked event{linkedEventsCount === 1 ? "" : "s"}
                  </span>
                )}
              </p>
            </div>

            <div className="rounded-lg border border-border p-4">
              <p className="text-sm font-medium text-foreground">
                What claiming this {kind} lets you do (free):
              </p>
              <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                <li className="flex items-start gap-2">
                  <CheckCircle2
                    className="mt-0.5 h-4 w-4 flex-shrink-0 text-sage-600"
                    aria-hidden
                  />
                  Edit the description, photos, and contact details.
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2
                    className="mt-0.5 h-4 w-4 flex-shrink-0 text-sage-600"
                    aria-hidden
                  />
                  {entityType === "VENDOR"
                    ? "Manage your event applications and profile."
                    : "Manage your events and vendor applications."}
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2
                    className="mt-0.5 h-4 w-4 flex-shrink-0 text-sage-600"
                    aria-hidden
                  />
                  Show a &ldquo;Claimed&rdquo; badge on the public page.
                </li>
              </ul>
            </div>

            <Button onClick={() => setStep(1)}>
              Continue
              <ArrowRight className="ml-1 h-4 w-4" />
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Step 1 — Account */}
      {step === 1 && (
        <Card>
          <CardContent className="p-6 space-y-4">
            <h2 className="text-lg font-semibold text-foreground">Your account</h2>
            {isLoggedIn ? (
              <>
                <p className="text-sm text-muted-foreground">
                  You&apos;re signed in. Continue to verify your connection to {entityName}.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => setStep(0)}>
                    Back
                  </Button>
                  <Button onClick={() => setStep(2)}>
                    Continue
                    <ArrowRight className="ml-1 h-4 w-4" />
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  You need an account to claim {entityName}. Create one or sign in — we&apos;ll
                  bring you right back to finish.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Link href={registerHref} rel="nofollow">
                    <Button>Create a free account</Button>
                  </Link>
                  <Link href={loginHref} rel="nofollow">
                    <Button variant="outline">Sign in</Button>
                  </Link>
                </div>
                <button
                  type="button"
                  onClick={() => setStep(0)}
                  className="text-sm text-muted-foreground hover:underline"
                >
                  Back
                </button>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Step 2 — Verify */}
      {step === 2 && (
        <Card>
          <CardContent className="p-6 space-y-4">
            <h2 className="text-lg font-semibold text-foreground">Verify your claim</h2>

            {!result && (
              <>
                <p className="text-sm text-muted-foreground">
                  We&apos;ll check whether your account already proves your connection to{" "}
                  {entityName} (a matching contact email or website domain). If not, you can submit
                  other evidence for review.
                </p>
                {error && (
                  <p className="text-sm text-terracotta" role="alert">
                    <AlertCircle className="mr-1 inline h-4 w-4 align-text-bottom" aria-hidden />
                    {error}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => setStep(1)} disabled={submitting}>
                    Back
                  </Button>
                  <Button onClick={submitClaim} disabled={submitting}>
                    {submitting ? "Checking…" : "Check my claim"}
                  </Button>
                </div>
              </>
            )}

            {result?.outcome === "approved" && (
              <ResultBox
                tone="success"
                icon={<ShieldCheck className="h-5 w-5 text-sage-700" aria-hidden />}
                title={`Approved — you now manage ${result.entityName ?? entityName}.`}
              >
                <p className="text-sm text-stone-600">
                  Ownership has been transferred to your account.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Link href={portalHref}>
                    <Button size="sm">Go to your {kind}</Button>
                  </Link>
                  <Link href="/dashboard/claims">
                    <Button size="sm" variant="outline">
                      View my claims
                    </Button>
                  </Link>
                </div>
              </ResultBox>
            )}

            {result?.outcome === "pending_verification" && (
              <ResultBox
                tone="info"
                icon={<Mail className="h-5 w-5 text-navy" aria-hidden />}
                title="Almost there — verify your email to finish."
              >
                <p className="text-sm text-stone-600">
                  {result.method === "DOMAIN_MATCH"
                    ? `Your account email's domain matches this ${kind}'s website.`
                    : `Your account email matches the contact email on this ${kind}.`}{" "}
                  To complete the claim we need to confirm you control that inbox. Check your email
                  and click the verification link — your claim is granted automatically once you do.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Link href="/verify-email/resend">
                    <Button size="sm" variant="outline">
                      Resend verification email
                    </Button>
                  </Link>
                </div>
              </ResultBox>
            )}

            {result?.outcome === "needs_evidence" && (
              <ResultBox
                tone="info"
                icon={<Mail className="h-5 w-5 text-navy" aria-hidden />}
                title="We couldn't confirm ownership automatically."
              >
                <p className="mb-4 text-sm text-stone-600">
                  Tell us how you&apos;re connected to {entityName} and we&apos;ll review it. Your
                  request is recorded and an operator will follow up.
                </p>
                <ClaimEvidenceForm entityType={entityType} slug={slug} entityName={entityName} />
              </ResultBox>
            )}

            {result?.outcome === "already_yours" && (
              <ResultBox
                tone="success"
                icon={<CheckCircle2 className="h-5 w-5 text-sage-700" aria-hidden />}
                title={`You already manage ${result.entityName ?? entityName}.`}
              >
                <div className="mt-3">
                  <Link href={portalHref}>
                    <Button size="sm">Go to your {kind}</Button>
                  </Link>
                </div>
              </ResultBox>
            )}

            {result?.outcome === "already_claimed" && (
              <ResultBox
                tone="warning"
                icon={<AlertCircle className="h-5 w-5 text-terracotta" aria-hidden />}
                title="This listing is already claimed."
              >
                <p className="text-sm text-stone-600">
                  Someone else has already claimed {entityName}. We&apos;ve recorded your request as
                  a dispute — our team will review it and follow up. If you believe this is a
                  mistake, you can add details below.
                </p>
                <div className="mt-4">
                  <ClaimEvidenceForm entityType={entityType} slug={slug} entityName={entityName} />
                </div>
              </ResultBox>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function ResultBox({
  tone,
  icon,
  title,
  children,
}: {
  tone: "success" | "info" | "warning";
  icon: React.ReactNode;
  title: string;
  children?: React.ReactNode;
}) {
  const border =
    tone === "success"
      ? "border-sage-300 bg-sage-50"
      : tone === "warning"
        ? "border-terracotta/30 bg-terracotta-light"
        : "border-border bg-stone-50";
  return (
    <div className={`rounded-lg border p-4 ${border}`}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex-shrink-0">{icon}</span>
        <div className="flex-1">
          <p className="text-sm font-semibold text-stone-900">{title}</p>
          <div className="mt-1">{children}</div>
        </div>
      </div>
    </div>
  );
}
