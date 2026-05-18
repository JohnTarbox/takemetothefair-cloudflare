"use client";

import { useState, useEffect, useCallback } from "react";
import {
  RefreshCw,
  Database,
  CheckCircle,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
} from "lucide-react";
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
  eventName?: string;
  success: boolean;
  status: string;
  error?: string | null;
}

interface WorkflowOutput {
  processed: number;
  success: number;
  failure: number;
  notFound: number;
  capped: boolean;
  results: SyncResultItem[];
}

interface WorkflowStatus {
  workflowId: string;
  status: "queued" | "running" | "paused" | "complete" | "errored" | "terminated" | "waiting";
  output?: WorkflowOutput;
  error?: { message: string; name: string } | null;
}

type SyncMode = "missing" | "existing" | "all";

const POLL_INTERVAL_MS = 3000;
const TERMINAL_STATUSES = new Set(["complete", "errored", "terminated"]);

export function SchemaOrgSyncButton() {
  const [stats, setStats] = useState<SyncStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [workflowStatus, setWorkflowStatus] = useState<WorkflowStatus["status"] | null>(null);
  const [eventCount, setEventCount] = useState<number>(0);
  const [result, setResult] = useState<WorkflowOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSuccessTable, setShowSuccessTable] = useState(false);
  const [showFailedTable, setShowFailedTable] = useState(false);
  const [selectedFailed, setSelectedFailed] = useState<Set<string>>(new Set());

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/schema-org/stats");
      if (res.ok) {
        const data = (await res.json()) as SyncStats;
        setStats(data);
      }
    } catch {
      // Stats fetch failed, not critical
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  // Poll the Workflow status while a sync is in flight.
  useEffect(() => {
    if (!workflowId || !syncing) return;

    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/admin/schema-org/sync-workflow/${workflowId}/status`);
        if (!res.ok) {
          if (!cancelled) {
            setError("Failed to read workflow status.");
            setSyncing(false);
          }
          return;
        }
        const data = (await res.json()) as WorkflowStatus;
        if (cancelled) return;

        setWorkflowStatus(data.status);

        if (TERMINAL_STATUSES.has(data.status)) {
          setSyncing(false);
          if (data.status === "complete" && data.output) {
            setResult(data.output);
          } else if (data.status === "errored") {
            setError(`Workflow failed: ${data.error?.message ?? "unknown"}`);
          } else if (data.status === "terminated") {
            setError("Workflow was terminated before completion.");
          }
          // Refresh stats after terminal state.
          await fetchStats();
        }
      } catch {
        if (!cancelled) {
          setError("Failed to read workflow status.");
          setSyncing(false);
        }
      }
    };

    // Run once immediately, then on interval.
    void tick();
    const handle = setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [workflowId, syncing, fetchStats]);

  const handleSync = async (mode: SyncMode, eventIds?: string[]) => {
    setSyncing(true);
    setError(null);
    setResult(null);
    setWorkflowId(null);
    setWorkflowStatus(null);
    setShowSuccessTable(false);
    setShowFailedTable(false);
    setSelectedFailed(new Set());

    try {
      const body = eventIds && eventIds.length > 0 ? { eventIds } : { mode };
      const res = await fetch("/api/admin/schema-org/sync-workflow/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as {
        workflowId?: string;
        eventCount?: number;
        error?: string;
        message?: string;
      };
      if (!res.ok || !data.workflowId) {
        setError(data.message ?? data.error ?? "Failed to start sync workflow.");
        setSyncing(false);
        return;
      }
      setWorkflowId(data.workflowId);
      setEventCount(data.eventCount ?? 0);
      setWorkflowStatus("queued");
    } catch {
      setError("Failed to start sync workflow.");
      setSyncing(false);
    }
  };

  const coverage = stats
    ? Math.round((stats.eventsWithSchemaOrg / Math.max(stats.eventsWithTicketUrl, 1)) * 100)
    : 0;

  const missing = stats ? stats.eventsWithTicketUrl - stats.eventsWithSchemaOrg : 0;

  // Build per-event tables from the workflow's results array.
  const successfulEvents = result?.results.filter((r) => r.status === "available") ?? [];
  const failedEvents =
    result?.results.filter(
      (r) => !r.success && r.status !== "available" && r.status !== "not_found"
    ) ?? [];

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
                <span className="font-medium">{stats?.eventsWithTicketUrl || 0}</span> events have
                ticket URLs
              </p>
              <p>
                <span className="font-medium">{stats?.eventsWithSchemaOrg || 0}</span> have
                schema.org data ({coverage}% coverage)
              </p>
              {missing > 0 && !syncing && (
                <p className="text-yellow-600">
                  <span className="font-medium">{missing}</span> events missing schema.org data
                </p>
              )}
            </div>

            {/* Workflow in-progress indicator. Cloudflare's status() API
                only exposes coarse state (queued/running/complete/...); we
                don't get a live per-event count. Show the queued count + a
                spinner. */}
            {syncing && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm text-gray-600">
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  <span>
                    Workflow {workflowStatus ?? "starting"} — processing {eventCount} event
                    {eventCount === 1 ? "" : "s"}…
                  </span>
                </div>
                {workflowId && <p className="text-xs text-gray-400">workflow id: {workflowId}</p>}
              </div>
            )}

            {/* Result message */}
            {result && !syncing && (
              <div className="space-y-3">
                <div
                  className={`p-3 rounded-md text-sm flex items-start gap-2 ${
                    result.failure > 0
                      ? "bg-yellow-50 text-yellow-800"
                      : "bg-green-50 text-green-800"
                  }`}
                >
                  {result.failure > 0 ? (
                    <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  ) : (
                    <CheckCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  )}
                  <div>
                    <p className="font-medium">Sync complete</p>
                    <p>
                      {result.success} succeeded, {result.notFound} not found, {result.failure}{" "}
                      failed
                      {result.capped && " (capped at 1000 events)"}
                    </p>
                  </div>
                </div>

                {/* Successful events table */}
                {successfulEvents.length > 0 && (
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
                      {successfulEvents.length} events with schema.org data
                    </button>
                    {showSuccessTable && (
                      <div className="max-h-48 overflow-y-auto">
                        <table className="w-full text-sm">
                          <thead className="bg-gray-50 sticky top-0">
                            <tr>
                              <th className="text-left px-3 py-2 font-medium text-gray-700">
                                Event
                              </th>
                              <th className="text-right px-3 py-2 font-medium text-gray-700 w-20">
                                Actions
                              </th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {successfulEvents.map((event) => (
                              <tr key={event.eventId} className="hover:bg-gray-50">
                                <td className="px-3 py-2 text-gray-900">
                                  {event.eventName ?? event.eventId}
                                </td>
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
                {failedEvents.length > 0 && (
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
                      {failedEvents.length} events failed
                    </button>
                    {showFailedTable && (
                      <>
                        <div className="max-h-48 overflow-y-auto">
                          <table className="w-full text-sm">
                            <thead className="bg-gray-50 sticky top-0">
                              <tr>
                                <th className="px-3 py-2 w-8">
                                  <input
                                    type="checkbox"
                                    checked={
                                      selectedFailed.size === failedEvents.length &&
                                      failedEvents.length > 0
                                    }
                                    onChange={(e) => {
                                      if (e.target.checked) {
                                        setSelectedFailed(
                                          new Set(failedEvents.map((ev) => ev.eventId))
                                        );
                                      } else {
                                        setSelectedFailed(new Set());
                                      }
                                    }}
                                    className="rounded border-gray-300"
                                  />
                                </th>
                                <th className="text-left px-3 py-2 font-medium text-gray-700">
                                  Event
                                </th>
                                <th className="text-left px-3 py-2 font-medium text-gray-700">
                                  Error
                                </th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100">
                              {failedEvents.map((event) => (
                                <tr key={event.eventId} className="hover:bg-gray-50">
                                  <td className="px-3 py-2">
                                    <input
                                      type="checkbox"
                                      checked={selectedFailed.has(event.eventId)}
                                      onChange={(e) => {
                                        const newSet = new Set(selectedFailed);
                                        if (e.target.checked) {
                                          newSet.add(event.eventId);
                                        } else {
                                          newSet.delete(event.eventId);
                                        }
                                        setSelectedFailed(newSet);
                                      }}
                                      className="rounded border-gray-300"
                                    />
                                  </td>
                                  <td className="px-3 py-2 text-gray-900">
                                    {event.eventName ?? event.eventId}
                                  </td>
                                  <td className="px-3 py-2 text-red-600 text-xs">
                                    {event.error || event.status || "Unknown error"}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        {selectedFailed.size > 0 && (
                          <div className="px-3 py-2 bg-red-50 border-t border-red-200">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => handleSync("all", Array.from(selectedFailed))}
                              disabled={syncing}
                            >
                              <RefreshCw
                                className={`w-4 h-4 mr-1 ${syncing ? "animate-spin" : ""}`}
                              />
                              Retry {selectedFailed.size} Selected
                            </Button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {error && <div className="p-3 bg-red-50 text-red-600 rounded-md text-sm">{error}</div>}

            {/* Action buttons */}
            <div className="flex flex-wrap gap-2">
              {missing > 0 && (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => handleSync("missing")}
                  disabled={syncing}
                >
                  <RefreshCw className={`w-4 h-4 mr-1 ${syncing ? "animate-spin" : ""}`} />
                  {syncing ? "Syncing..." : `Sync ${missing} Missing`}
                </Button>
              )}
              {(stats?.eventsWithSchemaOrg || 0) > 0 && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => handleSync("existing")}
                  disabled={syncing}
                >
                  <RefreshCw className={`w-4 h-4 mr-1 ${syncing ? "animate-spin" : ""}`} />
                  {syncing ? "Syncing..." : `Refresh ${stats?.eventsWithSchemaOrg} Existing`}
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => handleSync("all")}
                disabled={syncing}
              >
                <RefreshCw className={`w-4 h-4 mr-1 ${syncing ? "animate-spin" : ""}`} />
                {syncing ? "Syncing..." : "Refresh All"}
              </Button>
            </div>

            <p className="text-xs text-gray-400">
              Fetches schema.org Event markup from ticket URLs to keep event data in sync. Runs as a
              Cloudflare Workflow — durable per-event retry, no 30s response cap.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
