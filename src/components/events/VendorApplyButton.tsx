"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Calendar, Clock, Users, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getErrorMessage } from "@/lib/error-messages";
import { trackEvent } from "@/lib/analytics";

interface VendorApplyButtonProps {
  eventId: string;
  eventName: string;
  canSelfConfirm?: boolean;
  /** Event.applicationDeadline as an ISO string, if set */
  applicationDeadline?: string | null;
  /** Count of currently APPROVED or CONFIRMED vendors */
  confirmedVendorsCount?: number;
  /** Median response days for this promoter (null if insufficient data) */
  promoterMedianResponseDays?: number | null;
}

function formatRelativeDeadline(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const nowMs = Date.now();
  const diffDays = Math.ceil((d.getTime() - nowMs) / (24 * 60 * 60 * 1000));
  if (diffDays < 0) return null; // passed — skip
  const formatted = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  if (diffDays === 0) return `Applications close today (${formatted})`;
  if (diffDays === 1) return `Applications close tomorrow (${formatted})`;
  if (diffDays <= 14) return `Applications close in ${diffDays} days (${formatted})`;
  return `Applications close ${formatted}`;
}

export function VendorApplyButton({
  eventId,
  eventName,
  canSelfConfirm,
  applicationDeadline,
  confirmedVendorsCount,
  promoterMedianResponseDays,
}: VendorApplyButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [wasAutoApproved, setWasAutoApproved] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [boothInfo, setBoothInfo] = useState("");

  // Deadline text depends on "now", so compute on the client after hydration
  // to avoid SSR mismatch. Must be declared before any early return.
  const [deadlineText, setDeadlineText] = useState<string | null>(null);
  useEffect(() => {
    setDeadlineText(formatRelativeDeadline(applicationDeadline));
  }, [applicationDeadline]);

  const handleApply = async () => {
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/vendor/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId, boothInfo: boothInfo || undefined }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        if (data.error) {
          throw new Error(data.error);
        }
        throw res;
      }

      const result = (await res.json()) as { id?: string; status?: string };
      setWasAutoApproved(result.status === "CONFIRMED");
      if (result.id) setCreatedId(result.id);
      setSuccess(true);
      trackEvent("vendor_apply", { category: "conversion", label: eventId });
    } catch (err) {
      setError(getErrorMessage(err, "submit your application"));
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    const status = wasAutoApproved ? "CONFIRMED" : "APPLIED";
    const href = `/vendor/applications?status=${status}${createdId ? `&highlight=${createdId}` : ""}`;
    return (
      <div className="text-center space-y-3">
        <p className="text-sage-700 font-semibold">
          {wasAutoApproved ? "Confirmed!" : "Application Submitted!"}
        </p>
        <p className="text-sm text-stone-600">
          {wasAutoApproved
            ? "You're confirmed to participate in this event."
            : "We'll notify you when your application is reviewed."}
        </p>
        <Link
          href={href}
          className="inline-flex items-center gap-1 text-sm font-medium text-navy hover:underline"
        >
          View your applications
          <ArrowRight className="w-3 h-3" aria-hidden />
        </Link>
      </div>
    );
  }

  // Context chips shown on both the collapsed and expanded states so a vendor
  // can see the three trust signals (deadline / confirmed count / typical
  // response time) before deciding to apply.
  const hasContext =
    !!deadlineText ||
    (confirmedVendorsCount !== undefined && confirmedVendorsCount > 0) ||
    (promoterMedianResponseDays !== undefined && promoterMedianResponseDays !== null);

  const contextBlock = hasContext ? (
    <ul className="space-y-1.5 text-sm">
      {deadlineText && (
        <li className="flex items-center gap-2 text-stone-900">
          <Calendar className="w-4 h-4 text-amber-dark flex-shrink-0" aria-hidden />
          {deadlineText}
        </li>
      )}
      {confirmedVendorsCount !== undefined && confirmedVendorsCount > 0 && (
        <li className="flex items-center gap-2 text-stone-900">
          <Users className="w-4 h-4 text-sage-700 flex-shrink-0" aria-hidden />
          {confirmedVendorsCount} vendor{confirmedVendorsCount === 1 ? "" : "s"} already confirmed
        </li>
      )}
      {promoterMedianResponseDays !== undefined && promoterMedianResponseDays !== null && (
        <li className="flex items-center gap-2 text-stone-900">
          <Clock className="w-4 h-4 text-navy flex-shrink-0" aria-hidden />
          Promoter typically responds in ~{promoterMedianResponseDays} day
          {promoterMedianResponseDays === 1 ? "" : "s"}
        </li>
      )}
    </ul>
  ) : null;

  if (!isOpen) {
    return (
      <div className="space-y-3">
        {contextBlock}
        <Button className="w-full" onClick={() => setIsOpen(true)}>
          {canSelfConfirm ? "Confirm Participation" : "Apply as Vendor"}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {contextBlock}
      <p className="text-sm text-stone-600">
        {canSelfConfirm ? (
          <>
            Confirm your participation as a vendor at <strong>{eventName}</strong>
          </>
        ) : (
          <>
            Apply to participate as a vendor at <strong>{eventName}</strong>
          </>
        )}
      </p>

      <div>
        <Label htmlFor="boothInfo">Booth Preferences (optional)</Label>
        <Input
          id="boothInfo"
          placeholder="e.g., corner spot, near entrance"
          value={boothInfo}
          onChange={(e) => setBoothInfo(e.target.value)}
        />
      </div>

      {error && <div className="p-2 bg-red-50 text-red-600 text-sm rounded">{error}</div>}

      <div className="flex gap-2">
        <Button className="flex-1" onClick={handleApply} disabled={loading}>
          {loading
            ? canSelfConfirm
              ? "Confirming..."
              : "Submitting..."
            : canSelfConfirm
              ? "Confirm"
              : "Submit Application"}
        </Button>
        <Button variant="outline" onClick={() => setIsOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
