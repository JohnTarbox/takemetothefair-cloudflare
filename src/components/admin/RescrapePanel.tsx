"use client";

import { useState } from "react";
import { RefreshCw, ExternalLink, CheckCircle, AlertCircle } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface RescrapePanelProps {
  eventId: string;
  sourceName: string | null;
  sourceUrl: string | null;
  lastSyncedAt: string | Date | null;
  onRescrapeComplete?: () => void;
}

interface RescrapeResult {
  updated: number;
  skipped: number;
  details: {
    id: string;
    name: string;
    status: "updated" | "skipped" | "no_source" | "no_scraper" | "error";
    fieldsUpdated?: string[];
    error?: string;
  }[];
  errors: string[];
}

export function RescrapePanel({
  eventId,
  sourceName,
  sourceUrl,
  lastSyncedAt,
  onRescrapeComplete,
}: RescrapePanelProps) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<RescrapeResult | null>(null);
  const [error, setError] = useState("");

  const handleRescrape = async () => {
    setLoading(true);
    setError("");
    setResult(null);

    try {
      const res = await fetch("/api/admin/import/rescrape-events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_ids: [eventId] }),
      });

      const data = (await res.json()) as RescrapeResult;

      if (!res.ok) {
        throw new Error(
          (data as unknown as { error: string }).error || "Re-scrape failed"
        );
      }

      setResult(data);
      if (data.updated > 0) {
        onRescrapeComplete?.();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Re-scrape failed");
    } finally {
      setLoading(false);
    }
  };

  if (!sourceName && !sourceUrl) {
    return null;
  }

  const detail = result?.details?.[0];
  const formattedSyncDate = lastSyncedAt
    ? new Date(lastSyncedAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "Never";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-gray-900">Source Data</h3>
            <p className="text-sm text-gray-500 mt-1">
              Re-scrape this event from its original source to refresh data.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRescrape}
            disabled={loading || !sourceUrl}
          >
            <RefreshCw
              className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`}
            />
            {loading ? "Scraping..." : "Re-scrape"}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-500">Source</span>
            <span className="text-gray-900">{sourceName || "Unknown"}</span>
          </div>
          {sourceUrl && (
            <div className="flex justify-between">
              <span className="text-gray-500">URL</span>
              <a
                href={sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:underline flex items-center gap-1 max-w-xs truncate"
              >
                {new URL(sourceUrl).hostname}
                <ExternalLink className="w-3 h-3 flex-shrink-0" />
              </a>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-gray-500">Last synced</span>
            <span className="text-gray-900">{formattedSyncDate}</span>
          </div>
        </div>

        {error && (
          <div className="mt-3 p-2 bg-red-50 text-red-600 text-sm rounded flex items-center gap-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            {error}
          </div>
        )}

        {detail && (
          <div className="mt-3">
            {detail.status === "updated" && (
              <div className="p-2 bg-green-50 text-green-700 text-sm rounded flex items-center gap-2">
                <CheckCircle className="w-4 h-4 flex-shrink-0" />
                Updated: {detail.fieldsUpdated?.join(", ")}
              </div>
            )}
            {detail.status === "skipped" && (
              <div className="p-2 bg-gray-50 text-gray-600 text-sm rounded">
                No changes found — data is already up to date.
              </div>
            )}
            {detail.status === "no_scraper" && (
              <div className="p-2 bg-yellow-50 text-yellow-700 text-sm rounded flex items-center gap-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                No scraper available for source &quot;{sourceName}&quot;
              </div>
            )}
            {detail.status === "no_source" && (
              <div className="p-2 bg-yellow-50 text-yellow-700 text-sm rounded">
                Missing source URL — cannot re-scrape.
              </div>
            )}
            {detail.status === "error" && (
              <div className="p-2 bg-red-50 text-red-600 text-sm rounded flex items-center gap-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                {detail.error}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
