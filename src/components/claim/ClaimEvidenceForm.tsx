"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { CheckCircle2, AlertCircle } from "lucide-react";

interface Props {
  entityType: "VENDOR" | "PROMOTER";
  slug: string;
  entityName: string;
}

/**
 * Evidence intake form for the "verify another way" claim path (OPE-59).
 * POSTs free text to /api/claim/evidence, which attaches it to the user's
 * PENDING claim and flags it for operator review. Renders a terminal
 * "submitted" state on success.
 */
export function ClaimEvidenceForm({ entityType, slug, entityName }: Props) {
  const [evidence, setEvidence] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!evidence.trim()) {
      setStatus("error");
      setMessage("Please tell us how you're connected to this listing.");
      return;
    }
    setStatus("sending");
    setMessage(null);
    try {
      const res = await fetch("/api/claim/evidence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityType, slug, evidence: evidence.trim() }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setStatus("error");
        setMessage(body.error ?? "Something went wrong. Please try again.");
        return;
      }
      setStatus("sent");
    } catch (err) {
      setStatus("error");
      setMessage(`Network error: ${(err as Error).message}`);
    }
  }

  if (status === "sent") {
    return (
      <div className="rounded-lg border border-sage-300 bg-sage-50 p-4 flex items-start gap-3">
        <CheckCircle2 className="w-5 h-5 text-sage-700 flex-shrink-0 mt-0.5" aria-hidden />
        <div>
          <p className="text-sm font-semibold text-stone-900">Thanks — evidence submitted.</p>
          <p className="mt-1 text-sm text-stone-600">
            We&apos;ll review your connection to {entityName} and follow up. This usually takes a
            couple of business days.
          </p>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <label htmlFor="evidence" className="block text-sm font-medium text-foreground">
        How are you connected to {entityName}?
      </label>
      <textarea
        id="evidence"
        name="evidence"
        value={evidence}
        onChange={(e) => setEvidence(e.target.value)}
        rows={5}
        maxLength={4000}
        placeholder="e.g. I can reply from the business email, here's our Facebook/Instagram, our booth photo, or a registration/business document."
        className="block w-full rounded-lg border border-border px-3 py-2 text-foreground focus:border-royal focus:outline-none focus:ring-1 focus:ring-royal"
        required
      />
      {message && (
        <p
          className={`text-sm ${status === "error" ? "text-terracotta" : "text-sage-700"}`}
          role={status === "error" ? "alert" : "status"}
        >
          {status === "error" && (
            <AlertCircle className="w-4 h-4 inline mr-1 align-text-bottom" aria-hidden />
          )}
          {message}
        </p>
      )}
      <Button type="submit" disabled={status === "sending"}>
        {status === "sending" ? "Submitting…" : "Submit for review"}
      </Button>
    </form>
  );
}
