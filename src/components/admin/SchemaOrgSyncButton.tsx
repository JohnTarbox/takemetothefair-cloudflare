"use client";

import { useState, useEffect } from "react";
import { RefreshCw, Database, CheckCircle, AlertCircle } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface SyncStats {
  eventsWithTicketUrl: number;
  eventsWithSchemaOrg: number;
  statusBreakdown: Record<string, number>;
}

interface SyncResult {
  success: boolean;
  message: string;
  stats: {
    total: number;
    success: number;
    failed: number;
    notFound: number;
  };
  error?: string;
}

export function SchemaOrgSyncButton() {
  const [stats, setStats] = useState<SyncStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);

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

    try {
      const res = await fetch("/api/admin/schema-org/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          onlyMissing,
          limit: 100,
        }),
      });

      const data = await res.json() as SyncResult;
      setResult(data);

      // Refresh stats after sync
      await fetchStats();
    } catch {
      setError("Failed to sync. Please try again.");
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
              {missing > 0 && (
                <p className="text-yellow-600">
                  <span className="font-medium">{missing}</span> events missing schema.org data
                </p>
              )}
            </div>

            {/* Result message */}
            {result && (
              <div className={`p-3 rounded-md text-sm flex items-start gap-2 ${
                result.stats.failed > 0 ? "bg-yellow-50 text-yellow-800" : "bg-green-50 text-green-800"
              }`}>
                {result.stats.failed > 0 ? (
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                ) : (
                  <CheckCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                )}
                <div>
                  <p className="font-medium">Sync complete</p>
                  <p>
                    {result.stats.success} succeeded, {result.stats.notFound} not found, {result.stats.failed} failed
                  </p>
                </div>
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
