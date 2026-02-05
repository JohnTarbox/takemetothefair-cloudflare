"use client";

import { useState, useEffect } from "react";
import { RefreshCw, Database, CheckCircle, AlertCircle, ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import Link from "next/link";

interface SyncStats {
  eventsWithTicketUrl: number;
  eventsWithSchemaOrg: number;
  statusBreakdown: Record<string, number>;
}

interface SyncResultItem {
  eventId: string;
  eventName: string;
  success: boolean;
  status: string;
  error?: string;
}

interface SyncResponse {
  success: boolean;
  message: string;
  results: SyncResultItem[];
  stats: {
    total: number;
    success: number;
    failed: number;
    notFound: number;
  };
  error?: string;
}

interface AggregatedStats {
  total: number;
  processed: number;
  success: number;
  failed: number;
  notFound: number;
  successfulEvents: SyncResultItem[];
  failedEvents: SyncResultItem[];
}

const BATCH_SIZE = 10;

export function SchemaOrgSyncButton() {
  const [stats, setStats] = useState<SyncStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState<AggregatedStats | null>(null);
  const [result, setResult] = useState<AggregatedStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSuccessTable, setShowSuccessTable] = useState(false);
  const [showFailedTable, setShowFailedTable] = useState(false);

  useEffect(() => {
    fetchStats();
  }, []);

  const fetchStats = async () => {
    try {
      const res = await fetch("/api/admin/schema-org/sync");
      if (res.ok) {
        const data = await res.json() as SyncStats;
        setStats(data);
      }
    } catch {
      // Stats fetch failed, not critical
    } finally {
      setLoading(false);
    }
  };

  const handleSync = async (onlyMissing: boolean) => {
    setSyncing(true);
    setError(null);
    setResult(null);
    setShowSuccessTable(false);
    setShowFailedTable(false);

    const totalToSync = onlyMissing
      ? (stats?.eventsWithTicketUrl || 0) - (stats?.eventsWithSchemaOrg || 0)
      : (stats?.eventsWithTicketUrl || 0);

    const aggregated: AggregatedStats = {
      total: totalToSync,
      processed: 0,
      success: 0,
      failed: 0,
      notFound: 0,
      successfulEvents: [],
      failedEvents: [],
    };

    setProgress(aggregated);

    try {
      let hasMore = true;
      let batchNum = 0;

      while (hasMore && batchNum < 100) { // Safety limit of 100 batches (1000 events)
        const res = await fetch("/api/admin/schema-org/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            onlyMissing,
            limit: BATCH_SIZE,
          }),
        });

        const data = await res.json() as SyncResponse;

        if (!data.success || data.stats.total === 0) {
          hasMore = false;
        } else {
          // Update aggregated stats
          aggregated.processed += data.stats.total;
          aggregated.success += data.stats.success;
          aggregated.failed += data.stats.failed;
          aggregated.notFound += data.stats.notFound;

          // Track successful and failed events
          for (const item of data.results) {
            if (item.status === "available") {
              aggregated.successfulEvents.push(item);
            } else if (item.status === "error") {
              aggregated.failedEvents.push(item);
            }
          }

          setProgress({ ...aggregated });

          // If we got fewer than batch size, we're done
          if (data.stats.total < BATCH_SIZE) {
            hasMore = false;
          }
        }

        batchNum++;
      }

      setResult(aggregated);
      setProgress(null);

      // Refresh stats after sync
      await fetchStats();
    } catch {
      setError("Failed to sync. Please try again.");
      setProgress(null);
    } finally {
      setSyncing(false);
    }
  };

  const coverage = stats
    ? Math.round((stats.eventsWithSchemaOrg / Math.max(stats.eventsWithTicketUrl, 1)) * 100)
    : 0;

  const missing = stats
    ? stats.eventsWithTicketUrl - stats.eventsWithSchemaOrg
    : 0;

  const progressPercent = progress
    ? Math.round((progress.processed / Math.max(progress.total, 1)) * 100)
    : 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Database className="w-5 h-5 text-gray-600" />
          <h2 className="text-lg font-semibold text-gray-900">Schema.org Data</h2>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="animate-pulse space-y-2">
            <div className="h-4 bg-gray-200 rounded w-1/2"></div>
            <div className="h-4 bg-gray-200 rounded w-1/3"></div>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Stats */}
            <div className="text-sm text-gray-600 space-y-1">
              <p>
                <span className="font-medium">{stats?.eventsWithTicketUrl || 0}</span> events have ticket URLs
              </p>
              <p>
                <span className="font-medium">{stats?.eventsWithSchemaOrg || 0}</span> have schema.org data ({coverage}% coverage)
              </p>
              {missing > 0 && !syncing && (
                <p className="text-yellow-600">
                  <span className="font-medium">{missing}</span> events missing schema.org data
                </p>
              )}
            </div>

            {/* Progress indicator */}
            {syncing && progress && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-600">
                    Processing {progress.processed} of {progress.total} events...
                  </span>
                  <span className="font-medium text-gray-900">{progressPercent}%</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2.5 overflow-hidden">
                  <div
                    className="bg-blue-600 h-2.5 rounded-full transition-all duration-300 ease-out"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
                <div className="flex gap-4 text-xs text-gray-500">
                  <span className="text-green-600">{progress.success} succeeded</span>
                  <span className="text-gray-500">{progress.notFound} not found</span>
                  {progress.failed > 0 && (
                    <span className="text-red-600">{progress.failed} failed</span>
                  )}
                </div>
              </div>
            )}

            {/* Result message */}
            {result && !syncing && (
              <div className="space-y-3">
                <div className={`p-3 rounded-md text-sm flex items-start gap-2 ${
                  result.failed > 0 ? "bg-yellow-50 text-yellow-800" : "bg-green-50 text-green-800"
                }`}>
                  {result.failed > 0 ? (
                    <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  ) : (
                    <CheckCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  )}
                  <div>
                    <p className="font-medium">Sync complete</p>
                    <p>
                      {result.success} succeeded, {result.notFound} not found, {result.failed} failed
                    </p>
                  </div>
                </div>

                {/* Successful events table */}
                {result.successfulEvents.length > 0 && (
                  <div className="border rounded-md overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setShowSuccessTable(!showSuccessTable)}
                      className="w-full px-3 py-2 bg-green-50 text-green-800 text-sm font-medium flex items-center gap-2 hover:bg-green-100"
                    >
                      {showSuccessTable ? (
                        <ChevronDown className="w-4 h-4" />
                      ) : (
                        <ChevronRight className="w-4 h-4" />
                      )}
                      {result.successfulEvents.length} events with schema.org data
                    </button>
                    {showSuccessTable && (
                      <div className="max-h-48 overflow-y-auto">
                        <table className="w-full text-sm">
                          <thead className="bg-gray-50 sticky top-0">
                            <tr>
                              <th className="text-left px-3 py-2 font-medium text-gray-700">Event</th>
                              <th className="text-right px-3 py-2 font-medium text-gray-700 w-20">Actions</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {result.successfulEvents.map((event) => (
                              <tr key={event.eventId} className="hover:bg-gray-50">
                                <td className="px-3 py-2 text-gray-900">{event.eventName}</td>
                                <td className="px-3 py-2 text-right">
                                  <Link
                                    href={`/admin/events/${event.eventId}/edit`}
                                    className="text-blue-600 hover:text-blue-800 inline-flex items-center gap-1"
                                  >
                                    Edit <ExternalLink className="w-3 h-3" />
                                  </Link>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}

                {/* Failed events table */}
                {result.failedEvents.length > 0 && (
                  <div className="border border-red-200 rounded-md overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setShowFailedTable(!showFailedTable)}
                      className="w-full px-3 py-2 bg-red-50 text-red-800 text-sm font-medium flex items-center gap-2 hover:bg-red-100"
                    >
                      {showFailedTable ? (
                        <ChevronDown className="w-4 h-4" />
                      ) : (
                        <ChevronRight className="w-4 h-4" />
                      )}
                      {result.failedEvents.length} events failed
                    </button>
                    {showFailedTable && (
                      <div className="max-h-48 overflow-y-auto">
                        <table className="w-full text-sm">
                          <thead className="bg-gray-50 sticky top-0">
                            <tr>
                              <th className="text-left px-3 py-2 font-medium text-gray-700">Event</th>
                              <th className="text-left px-3 py-2 font-medium text-gray-700">Error</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {result.failedEvents.map((event) => (
                              <tr key={event.eventId} className="hover:bg-gray-50">
                                <td className="px-3 py-2 text-gray-900">{event.eventName}</td>
                                <td className="px-3 py-2 text-red-600 text-xs">{event.error || "Unknown error"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {error && (
              <div className="p-3 bg-red-50 text-red-600 rounded-md text-sm">
                {error}
              </div>
            )}

            {/* Action buttons */}
            <div className="flex flex-wrap gap-2">
              {missing > 0 && (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => handleSync(true)}
                  disabled={syncing}
                >
                  <RefreshCw className={`w-4 h-4 mr-1 ${syncing ? "animate-spin" : ""}`} />
                  {syncing ? "Syncing..." : `Sync ${missing} Missing`}
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => handleSync(false)}
                disabled={syncing}
              >
                <RefreshCw className={`w-4 h-4 mr-1 ${syncing ? "animate-spin" : ""}`} />
                {syncing ? "Syncing..." : "Refresh All"}
              </Button>
            </div>

            <p className="text-xs text-gray-400">
              Fetches schema.org Event markup from ticket URLs to keep event data in sync.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
