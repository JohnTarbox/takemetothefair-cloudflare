export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { getCloudflareDb } from "@/lib/cloudflare";
import { vendors, promoters } from "@/lib/db/schema";
import { unsafeSlug, decodeHtmlEntities } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { ClaimEvidenceForm } from "@/components/claim/ClaimEvidenceForm";

// This is a post-signup, logged-in-user surface — keep it out of the index.
export const metadata: Metadata = {
  title: "Verify your claim | Meet Me at the Fair",
  robots: { index: false, follow: false },
};

interface Props {
  params: Promise<{ type: string; slug: string }>;
  searchParams: Promise<{ method?: string }>;
}

type EntityType = "VENDOR" | "PROMOTER";

async function lookup(type: EntityType, slug: string): Promise<string | null> {
  const db = getCloudflareDb();
  if (type === "VENDOR") {
    const [row] = await db
      .select({ name: vendors.businessName })
      .from(vendors)
      .where(eq(vendors.slug, unsafeSlug(slug)))
      .limit(1);
    return row?.name ?? null;
  }
  const [row] = await db
    .select({ name: promoters.companyName })
    .from(promoters)
    .where(eq(promoters.slug, unsafeSlug(slug)))
    .limit(1);
  return row?.name ?? null;
}

export default async function ClaimVerifyPage({ params, searchParams }: Props) {
  const { type, slug } = await params;
  const { method } = await searchParams;
  // ?method=email → the account email matched the listing's contact address, so
  // the claim just needs the email verified (proof of inbox control) to
  // auto-complete. Show that path first; the evidence form is the fallback.
  const emailPending = method === "email";
  const normalized = type.toLowerCase();
  if (normalized !== "vendor" && normalized !== "promoter") {
    notFound();
  }
  const entityType: EntityType = normalized === "vendor" ? "VENDOR" : "PROMOTER";

  const rawName = await lookup(entityType, slug);
  if (rawName === null) {
    notFound();
  }
  const entityName = decodeHtmlEntities(rawName);

  return (
    <div className="mx-auto max-w-2xl px-4 sm:px-6 py-12">
      <Card>
        <CardContent className="p-6 space-y-4">
          {emailPending ? (
            <>
              <h1 className="text-2xl font-bold text-foreground">
                Almost there — verify your email
              </h1>
              <div className="rounded-md border border-royal/30 bg-royal/5 p-4 text-sm text-foreground">
                Your account email matches the contact address on <strong>{entityName}</strong>. We
                sent you a verification link —{" "}
                <strong>click it and your claim completes automatically</strong> (we require it as
                proof you control that inbox). Didn&apos;t get it? Check spam, or request a new link
                from your account.
              </div>
              <p className="text-sm text-muted-foreground pt-2">
                Can&apos;t access that inbox? Verify another way instead — tell us how you&apos;re
                connected and we&apos;ll review it.
              </p>
            </>
          ) : (
            <>
              <h1 className="text-2xl font-bold text-foreground">Verify another way</h1>
              <p className="text-muted-foreground">
                We couldn&apos;t instantly verify you own <strong>{entityName}</strong>. Tell us how
                you&apos;re connected — a reply from the business email, a social profile, a
                registration document, or a booth photo — and we&apos;ll review it.
              </p>
            </>
          )}
          <ClaimEvidenceForm entityType={entityType} slug={slug} entityName={entityName} />
        </CardContent>
      </Card>
    </div>
  );
}
