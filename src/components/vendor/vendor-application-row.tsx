"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Calendar, MapPin, Clock, AlertTriangle, Undo2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AddToCalendar } from "@/components/events/AddToCalendar";
import { formatDateRange } from "@/lib/utils";
import { STATUS_BADGE_VARIANTS, STATUS_LABELS } from "@/lib/vendor-status";

export interface VendorApplicationRowData {
  id: string;
  status: string;
  boothInfo: string | null;
  event: {
    name: string;
    slug: string;
    description: string | null;
    startDate: Date | string | null;
    endDate: Date | string | null;
    venue: {
      name: string;
      address: string | null;
      city: string;
      state: string;
      zip: string | null;
    } | null;
  };
}

interface Props {
  application: VendorApplicationRowData;
  conflicts: string[];
  highlighted?: boolean;
}

export function VendorApplicationRow({ application, conflicts, highlighted }: Props) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();
  const ref = useRef<HTMLDivElement | null>(null);
  const [pulse, setPulse] = useState(false);

  useEffect(() => {
    if (!highlighted || !ref.current) return;
    ref.current.scrollIntoView({ behavior: "smooth", block: "center" });
    setPulse(true);
    const t = setTimeout(() => setPulse(false), 2200);
    return () => clearTimeout(t);
  }, [highlighted]);

  const canWithdraw =
    application.status === "APPLIED" ||
    application.status === "INTERESTED" ||
    application.status === "INVITED" ||
    application.status === "WAITLISTED" ||
    application.status === "APPROVED";

  const handleWithdraw = async () => {
    if (
      !window.confirm(
        `Withdraw your application to "${application.event.name}"? You can reapply later if the event is still open.`
      )
    ) {
      return;
    }
    setError("");
    try {
      const res = await fetch(`/api/vendor/applications/${application.id}`, {
        method: "DELETE",
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Could not withdraw application.");
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError("Network error. Please try again.");
    }
  };

  return (
    <div
      ref={ref}
      className={`rounded-xl transition-shadow ${pulse ? "ring-2 ring-amber animate-pulse" : ""}`}
    >
      <Card>
        <CardContent className="p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3 flex-wrap">
                <Link
                  href={`/events/${application.event.slug}`}
                  className="text-lg font-semibold text-gray-900 hover:text-navy"
                >
                  {application.event.name}
                </Link>
                <Badge
                  variant={
                    STATUS_BADGE_VARIANTS[
                      application.status as keyof typeof STATUS_BADGE_VARIANTS
                    ] ?? "default"
                  }
                >
                  {STATUS_LABELS[application.status as keyof typeof STATUS_LABELS] ??
                    application.status}
                </Badge>
              </div>
              <div className="mt-2 space-y-1 text-sm text-gray-600">
                <div className="flex items-center gap-2">
                  <Calendar className="w-4 h-4" />
                  {formatDateRange(application.event.startDate, application.event.endDate)}
                  <AddToCalendar
                    title={application.event.name}
                    description={application.event.description || undefined}
                    location={
                      application.event.venue
                        ? `${application.event.venue.name}, ${application.event.venue.address || ""}, ${application.event.venue.city}, ${application.event.venue.state} ${application.event.venue.zip || ""}`
                        : undefined
                    }
                    startDate={application.event.startDate}
                    endDate={application.event.endDate}
                    url={`https://meetmeatthefair.com/events/${application.event.slug}`}
                    variant="icon"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <MapPin className="w-4 h-4" />
                  {application.event.venue
                    ? `${application.event.venue.name}, ${application.event.venue.city}, ${application.event.venue.state}`
                    : "Venue TBA"}
                </div>
                {application.boothInfo && (
                  <div className="flex items-center gap-2">
                    <Clock className="w-4 h-4" />
                    Booth: {application.boothInfo}
                  </div>
                )}
              </div>
              {conflicts.length > 0 && (
                <div className="mt-2 flex items-start gap-2 text-sm text-amber-700 bg-amber-50 rounded-md px-3 py-2">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span>Date conflict with: {conflicts.join(", ")}</span>
                </div>
              )}
              {error && (
                <div className="mt-2 text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">
                  {error}
                </div>
              )}
            </div>
            {canWithdraw && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleWithdraw}
                disabled={isPending}
                className="flex-shrink-0"
              >
                <Undo2 className="w-4 h-4 mr-1" />
                {isPending ? "Withdrawing…" : "Withdraw"}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
