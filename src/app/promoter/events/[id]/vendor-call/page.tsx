import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireRole } from "@/lib/require-role";
import { getCloudflareDb } from "@/lib/cloudflare";
import { loadPromoterVendorCall } from "@/lib/promoter/vendor-call";
import { VendorCallForm } from "./vendor-call-form";

/**
 * OPE-1513 — the promoter edits the vendor call on its OWN event: deadline,
 * booth fee, apply link, capacity, categories wanted / full. Ownership is the
 * loader's rule (the session's promoter row must own the event); anything else
 * is a 404, the same answer as an event that does not exist.
 */
export default async function PromoterVendorCallPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // OPE-1397 — the role guard is the first statement, before any read.
  const session = await requireRole("PROMOTER", "/promoter/events");
  const { id } = await params;
  const state = await loadPromoterVendorCall(getCloudflareDb(), session.user.id, id);
  if (!state) notFound();

  return (
    <div className="max-w-2xl space-y-6">
      <Link
        href="/promoter/events"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="w-4 h-4" /> My Events
      </Link>
      <div>
        <h1 className="text-2xl font-bold text-foreground">Vendor call</h1>
        <p className="text-muted-foreground">{state.event.name}</p>
      </div>
      <p className="text-sm text-muted-foreground">
        Tell vendors whether you&apos;re taking applications, when they close, what a booth costs,
        and which kinds of vendors you still need. We include open calls in our weekly vendor
        newsletter.
      </p>
      <VendorCallForm initial={state} />
    </div>
  );
}
