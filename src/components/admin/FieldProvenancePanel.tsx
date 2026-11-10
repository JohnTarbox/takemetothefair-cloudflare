"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

/**
 * OPE-1613 — where each cited field's current value came from, and which
 * fields a validated contact has pinned above the organizer's feed.
 */
interface ProvenanceRow {
  field: string;
  value: string;
  provenance: string;
  sourceName: string | null;
  sourceUrl: string;
  citedAt: string | null;
}
interface PinRow {
  field: string;
  pinnedValue: string;
  feedValueAtPin: string | null;
  createdAt: string | null;
}

const LABEL: Record<string, string> = {
  validated_contact: "Validated contact",
  feed: "Organizer feed",
  organizer_website: "Organizer website",
  operator: "Operator",
  extraction: "Extraction",
  unclassified: "Unclassified (pre-provenance)",
};

export function FieldProvenancePanel({ eventId }: { eventId: string }) {
  const [data, setData] = useState<{ fields: ProvenanceRow[]; pins: PinRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/admin/events/${eventId}/field-provenance`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => live && setData(d as { fields: ProvenanceRow[]; pins: PinRow[] }))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [eventId]);

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>Field provenance</CardTitle>
      </CardHeader>
      <CardContent>
        {error && <p className="text-sm text-red-600">Could not load provenance: {error}</p>}
        {!error && !data && <p className="text-sm text-gray-500">Loading…</p>}
        {data && data.fields.length === 0 && data.pins.length === 0 && (
          <p className="text-sm text-gray-500">No cited fields on this event.</p>
        )}
        {data && data.pins.length > 0 && (
          <div className="mb-4">
            <h4 className="mb-2 text-sm font-semibold">Pinned by a validated contact</h4>
            <ul className="space-y-1 text-sm">
              {data.pins.map((p) => (
                <li key={p.field}>
                  <span className="font-mono">{p.field}</span> = <strong>{p.pinnedValue}</strong>
                  {p.feedValueAtPin && (
                    <span className="text-gray-500"> (feed said {p.feedValueAtPin})</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {data && data.fields.length > 0 && (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-gray-500">
                <th className="py-1 pr-2">Field</th>
                <th className="py-1 pr-2">Value</th>
                <th className="py-1 pr-2">Source</th>
              </tr>
            </thead>
            <tbody>
              {data.fields.map((f) => (
                <tr key={f.field} className="border-t align-top">
                  <td className="py-1 pr-2 font-mono">{f.field}</td>
                  <td className="py-1 pr-2">{f.value}</td>
                  <td className="py-1 pr-2">
                    <Badge variant={f.provenance === "validated_contact" ? "success" : "default"}>
                      {LABEL[f.provenance] ?? f.provenance}
                    </Badge>
                    <div className="text-xs text-gray-500">
                      {f.sourceName ?? f.sourceUrl}
                      {f.citedAt && ` · ${f.citedAt.slice(0, 10)}`}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
