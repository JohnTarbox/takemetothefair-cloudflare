"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

type DomainType = "aggregator" | "promoter" | "ticketing" | "social" | "other";

interface Preset {
  type: DomainType;
  label: string;
  ticket: boolean;
  application: boolean;
  source: boolean;
  className: string;
}

// One-click presets for the common cases. The shape matches the seed rows in
// drizzle/0036_add_url_domain_classifications.sql so the discovery panel
// produces the same defaults humans hand-picked for the starter set.
const PRESETS: Preset[] = [
  {
    type: "aggregator",
    label: "Aggregator",
    ticket: false,
    application: false,
    source: true,
    className: "bg-red-100 text-red-800 hover:bg-red-200 border border-red-300",
  },
  {
    type: "promoter",
    label: "Promoter",
    ticket: true,
    application: true,
    source: true,
    className: "bg-green-100 text-green-800 hover:bg-green-200 border border-green-300",
  },
  {
    type: "ticketing",
    label: "Ticketing",
    ticket: true,
    application: false,
    source: false,
    className: "bg-blue-100 text-blue-800 hover:bg-blue-200 border border-blue-300",
  },
  {
    type: "social",
    label: "Social",
    ticket: true,
    application: false,
    source: false,
    className: "bg-purple-100 text-purple-800 hover:bg-purple-200 border border-purple-300",
  },
  {
    type: "other",
    label: "Other (block)",
    ticket: false,
    application: false,
    source: false,
    className: "bg-gray-200 text-gray-800 hover:bg-gray-300 border border-gray-400",
  },
];

interface ClassifyDomainButtonsProps {
  domain: string;
}

export function ClassifyDomainButtons({ domain }: ClassifyDomainButtonsProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<DomainType | null>(null);

  async function classify(preset: Preset) {
    setBusy(preset.type);
    try {
      const res = await fetch("/api/admin/url-classifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain,
          domain_type: preset.type,
          use_as_ticket_url: preset.ticket,
          use_as_application_url: preset.application,
          use_as_source: preset.source,
        }),
      });
      if (res.ok) {
        router.refresh();
      } else {
        const data = await res.json().catch(() => ({}));
        alert(`Failed: ${(data as Record<string, string>).error ?? res.statusText}`);
      }
    } catch {
      alert("Network error — please try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {PRESETS.map((preset) => (
        <Button
          key={preset.type}
          type="button"
          size="sm"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            classify(preset);
          }}
          disabled={busy !== null}
          className={`text-xs px-2 py-1 h-auto ${preset.className}`}
        >
          {busy === preset.type ? "…" : preset.label}
        </Button>
      ))}
    </div>
  );
}
