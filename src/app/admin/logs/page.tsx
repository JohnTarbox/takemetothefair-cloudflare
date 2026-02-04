"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const runtime = "edge";

interface ErrorLog {
  id: string;
  timestamp: number;
  time: string;
  level: string;
  message: string;
  context: string;
  url: string | null;
  method: string | null;
  statusCode: number | null;
  stackTrace: string | null;
  userAgent: string | null;
  source: string | null;
}

const levelColors: Record<string, "danger" | "warning" | "info" | "default"> = {
  error: "danger",
  warn: "warning",
  info: "info",
};

export default function AdminLogsPage() {
  const [logs, setLogs] = useState<ErrorLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [level, setLevel] = useState("");
  const [source, setSource] = useState("");
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(50);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("limit", String(limit));
      if (level) params.set("level", level);
      if (source) params.set("source", source);
      if (search) params.set("q", search);

      const res = await fetch(`/api/admin/logs?${params}`);
      const data = (await res.json()) as ErrorLog[];
      setLogs(data);
    } catch (error) {
      console.error("Failed to fetch logs:", error);
    } finally {
      setLoading(false);
    }
  }, [level, source, search, limit]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const deleteLog = async (id: string) => {
    if (!confirm("Delete this log entry?")) return;
    setDeleting(id);
    try {
      await fetch(`/api/admin/logs?id=${id}`, { method: "DELETE" });
      setLogs((prev) => prev.filter((log) => log.id !== id));
      if (expandedId === id) setExpandedId(null);
    } catch (error) {
      console.error("Failed to delete log:", error);
    } finally {
      setDeleting(null);
    }
  };

  const clearOldLogs = async (days: number) => {
    if (!confirm(`Delete all logs older than ${days} days?`)) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/logs?olderThan=${days}`, {
        method: "DELETE",
      });
      const data = (await res.json()) as { deleted: number };
      alert(`Deleted ${data.deleted} log entries`);
      fetchLogs();
    } catch (error) {
      console.error("Failed to clear old logs:", error);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Error Logs</h1>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => clearOldLogs(7)}
            className="px-4 py-2 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors text-red-600"
          >
            Clear 7+ days
          </button>
          <button
            type="button"
            onClick={fetchLogs}
            className="px-4 py-2 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      <Card className="mb-6">
        <CardContent className="pt-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Level
              </label>
              <select
                value={level}
                onChange={(e) => setLevel(e.target.value)}
                className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2"
              >
                <option value="">All levels</option>
                <option value="error">Error</option>
                <option value="warn">Warning</option>
                <option value="info">Info</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Source
              </label>
              <input
                type="text"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="e.g. api/admin/events"
                className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Search message
              </label>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search..."
                className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Limit
              </label>
              <select
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value))}
                className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2"
              >
                <option value={25}>25</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
                <option value={200}>200</option>
              </select>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <p className="text-sm text-gray-600">
            {loading ? "Loading..." : `${logs.length} log entries`}
          </p>
        </CardHeader>
        <CardContent>
          {!loading && logs.length === 0 ? (
            <p className="text-center text-gray-500 py-8">No log entries found.</p>
          ) : (
            <div className="space-y-2">
              {logs.map((log) => (
                <div
                  key={log.id}
                  className="border border-gray-200 rounded-lg overflow-hidden"
                >
                  <button
                    type="button"
                    onClick={() =>
                      setExpandedId(expandedId === log.id ? null : log.id)
                    }
                    className="w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex items-start gap-3">
                      <Badge variant={levelColors[log.level] || "default"}>
                        {log.level}
                      </Badge>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">
                          {log.message}
                        </p>
                        <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                          <span>{log.time}</span>
                          {log.source && (
                            <span className="font-mono bg-gray-100 px-1.5 py-0.5 rounded">
                              {log.source}
                            </span>
                          )}
                          {log.method && log.url && (
                            <span>
                              {log.method}{" "}
                              {(() => {
                                try {
                                  return new URL(log.url).pathname;
                                } catch {
                                  return log.url;
                                }
                              })()}
                            </span>
                          )}
                          {log.statusCode && (
                            <span>HTTP {log.statusCode}</span>
                          )}
                        </div>
                      </div>
                      <span className="text-gray-400 text-sm">
                        {expandedId === log.id ? "▲" : "▼"}
                      </span>
                    </div>
                  </button>

                  {expandedId === log.id && (
                    <div className="px-4 py-3 border-t border-gray-200 bg-gray-50 space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm flex-1">
                          <div>
                            <span className="font-medium text-gray-600">ID: </span>
                            <span className="font-mono text-xs">{log.id}</span>
                          </div>
                          <div>
                            <span className="font-medium text-gray-600">Timestamp: </span>
                            <span>{log.time}</span>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => deleteLog(log.id)}
                          disabled={deleting === log.id}
                          className="px-3 py-1 text-xs text-red-600 border border-red-300 rounded hover:bg-red-50 disabled:opacity-50 transition-colors"
                        >
                          {deleting === log.id ? "Deleting..." : "Delete"}
                        </button>
                      </div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                        {log.url && (
                          <div className="col-span-2">
                            <span className="font-medium text-gray-600">URL: </span>
                            <span className="font-mono text-xs break-all">{log.url}</span>
                          </div>
                        )}
                        {log.userAgent && (
                          <div className="col-span-2">
                            <span className="font-medium text-gray-600">User Agent: </span>
                            <span className="text-xs break-all">{log.userAgent}</span>
                          </div>
                        )}
                      </div>

                      {log.context && log.context !== "{}" && (
                        <div>
                          <p className="text-sm font-medium text-gray-600 mb-1">Context</p>
                          <pre className="text-xs bg-white border border-gray-200 rounded p-2 overflow-x-auto">
                            {JSON.stringify(JSON.parse(log.context), null, 2)}
                          </pre>
                        </div>
                      )}

                      {log.stackTrace && (
                        <div>
                          <p className="text-sm font-medium text-gray-600 mb-1">Stack Trace</p>
                          <pre className="text-xs bg-white border border-gray-200 rounded p-2 overflow-x-auto whitespace-pre-wrap">
                            {log.stackTrace}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
