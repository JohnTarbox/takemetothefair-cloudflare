"use client";

import { useState } from "react";
import { Mail, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  vendorSlug: string;
  vendorName: string;
}

/**
 * Modal contact form for Enhanced Profile vendors. POSTs to
 * /api/vendors/[slug]/contact, which forwards to the vendor's email
 * server-side — the recipient address never enters the DOM.
 *
 * Free vendors don't get this component; their `contactEmail` is rendered
 * raw in the existing flow (round-3 didn't change that).
 */
export function VendorContactForm({ vendorSlug, vendorName }: Props) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<"idle" | "ok" | "err">("idle");
  const [errMsg, setErrMsg] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setStatus("idle");
    setErrMsg(null);

    const form = e.currentTarget;
    const data = new FormData(form);
    const body = {
      senderName: data.get("senderName"),
      senderEmail: data.get("senderEmail"),
      message: data.get("message"),
    };

    try {
      const res = await fetch(`/api/vendors/${vendorSlug}/contact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        setStatus("err");
        setErrMsg(err.error ?? "Failed to send message. Try again?");
      } else {
        setStatus("ok");
        form.reset();
      }
    } catch {
      setStatus("err");
      setErrMsg("Network error. Try again?");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Button type="button" onClick={() => setOpen(true)} className="gap-2">
        <Mail className="w-4 h-4" />
        Contact {vendorName}
      </Button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
        >
          <div className="bg-white rounded-lg max-w-md w-full p-6 relative">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="absolute top-3 right-3 text-gray-500 hover:text-gray-900"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
            <h2 className="text-xl font-semibold mb-4">Contact {vendorName}</h2>

            {status === "ok" ? (
              <div>
                <p className="text-sm text-gray-700">
                  Your message has been sent. {vendorName} will reply directly to your email.
                </p>
                <Button type="button" onClick={() => setOpen(false)} className="mt-4">
                  Close
                </Button>
              </div>
            ) : (
              <form onSubmit={onSubmit} className="space-y-3">
                <div>
                  <label htmlFor="senderName" className="block text-sm font-medium mb-1">
                    Your name
                  </label>
                  <input
                    id="senderName"
                    name="senderName"
                    type="text"
                    required
                    maxLength={100}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label htmlFor="senderEmail" className="block text-sm font-medium mb-1">
                    Your email
                  </label>
                  <input
                    id="senderEmail"
                    name="senderEmail"
                    type="email"
                    required
                    maxLength={255}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label htmlFor="message" className="block text-sm font-medium mb-1">
                    Message
                  </label>
                  <textarea
                    id="message"
                    name="message"
                    required
                    rows={5}
                    maxLength={2000}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
                {status === "err" && errMsg && <p className="text-sm text-red-600">{errMsg}</p>}
                <Button type="submit" disabled={submitting} className="w-full">
                  {submitting ? "Sending..." : "Send message"}
                </Button>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}
