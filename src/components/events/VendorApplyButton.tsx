"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getErrorMessage } from "@/lib/error-messages";

interface VendorApplyButtonProps {
  eventId: string;
  eventName: string;
}

export function VendorApplyButton({ eventId, eventName }: VendorApplyButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [boothInfo, setBoothInfo] = useState("");

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
        const data = await res.json() as { error?: string };
        if (data.error) {
          throw new Error(data.error);
        }
        throw res;
      }

      setSuccess(true);
    } catch (err) {
      setError(getErrorMessage(err, "submit your application"));
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="text-center">
        <p className="text-green-600 font-medium">Application Submitted!</p>
        <p className="text-sm text-gray-500 mt-1">
          We&apos;ll notify you when your application is reviewed.
        </p>
      </div>
    );
  }

  if (!isOpen) {
    return (
      <Button className="w-full" onClick={() => setIsOpen(true)}>
        Apply as Vendor
      </Button>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">
        Apply to participate as a vendor at <strong>{eventName}</strong>
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

      {error && (
        <div className="p-2 bg-red-50 text-red-600 text-sm rounded">
          {error}
        </div>
      )}

      <div className="flex gap-2">
        <Button className="flex-1" onClick={handleApply} disabled={loading}>
          {loading ? "Submitting..." : "Submit Application"}
        </Button>
        <Button variant="outline" onClick={() => setIsOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
