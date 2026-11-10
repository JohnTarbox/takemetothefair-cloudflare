"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

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

interface ErrorLogGroup {
  source: string;
  level: string;
  example: string;
  count: number;
  firstSeenSec: number;
  lastSeenSec: number;
  searchHint: string;
}

interface GroupedResponse {
  groups: ErrorLogGroup[];
  totalGroups: number;
  totalRows: number;
  truncated: boolean;
  windowDays: number;
}

function formatSeen(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 19).replace("T", " ");
}

const levelColors: Record<string, "danger" | "warning" | "info" | "default"> = {
  error: "danger",
  warn: "warning",
  info: "info",
};

// OPE-92 — seed the level/source filters from the URL so the canary emails'
// deep-links (e.g. /admin/logs?source=<x>) land pre-filtered. Lazy client-only
// read of window.location so no Suspense boundary is needed (unlike
// useSearchParams). Absent/SSR → "" (the previous default).
function initialParam(key: string): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get(key) ?? "";
}

export default function AdminLogsPage() {
  const [logs, setLogs] = useState<ErrorLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [level, setLevel] = useState(() => initialParam("level"));
  const [source, setSource] = useState(() => initialParam("source"));
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(50);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // OPE-1601 — grouped is the default; `?view=raw` keeps the flat list linkable.
  const [view, setView] = useState<"grouped" | "raw">(() =>
    initialParam("view") === "raw" ? "raw" : "grouped"
  );
  const [days, setDays] = useState(7);
  const [grouped, setGrouped] = useState<GroupedResponse | null>(null);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (level) params.set("level", level);
      if (source) params.set("source", source);
      if (search) params.set("q", search);

      if (view === "grouped") {
        params.set("view", "grouped");
        params.set("days", String(days));
        const res = await fetch(`/api/admin/logs?${params}`);
        setGrouped((await res.json()) as GroupedResponse);
      } else {
        params.set("limit", String(limit));
        const res = await fetch(`/api/admin/logs?${params}`);
        setLogs((await res.json()) as ErrorLog[]);
      }
    } catch (error) {
      console.error("Failed to fetch logs:", error);
    } finally {
      setLoading(false);
    }
  }, [level, source, search, limit, view, days]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  // A group's rows, in the raw list.
  const showGroupRows = (group: ErrorLogGroup) => {
    setSource(group.source === "(unknown)" ? "" : group.source);
    setLevel(group.level);
    setSearch(group.searchHint);
    setLimit(200);
    setView("raw");
  };

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
        <h1 className="text-2xl font-bold text-foreground">Error Logs</h1>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => clearOldLogs(7)}
            className="px-4 py-2 text-sm bg-card border border-border rounded-lg hover:bg-muted transition-colors text-red-600"
          >
            Clear 7+ days
          </button>
          <button
            type="button"
            onClick={fetchLogs}
            className="px-4 py-2 text-sm bg-card border border-border rounded-lg hover:bg-muted transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 mb-4" role="group" aria-label="Log view">
        {(["grouped", "raw"] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={view === option}
            onClick={() => setView(option)}
            className={`px-4 py-2 text-sm border border-border rounded-lg transition-colors ${
              view === option ? "bg-muted font-medium" : "bg-card hover:bg-muted"
            }`}
          >
            {option === "grouped" ? "Grouped" : "All rows"}
          </button>
        ))}
      </div>

      <Card className="mb-6">
        <CardContent className="pt-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">Level</label>
              <select
                value={level}
                onChange={(e) => setLevel(e.target.value)}
                className="w-full text-sm border border-border rounded-lg px-3 py-2"
              >
                <option value="">
                  {view === "grouped" ? "Errors and warnings" : "All levels"}
                </option>
                <option value="error">Error</option>
                <option value="warn">Warning</option>
                <option value="info">Info</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">Source</label>
              <input
                type="text"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="e.g. api/admin/events"
                className="w-full text-sm border border-border rounded-lg px-3 py-2"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Search message
              </label>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search..."
                className="w-full text-sm border border-border rounded-lg px-3 py-2"
              />
            </div>
            <div>
              {view === "grouped" ? (
                <>
                  <label className="block text-sm font-medium text-foreground mb-1">Window</label>
                  <select
                    value={days}
                    onChange={(e) => setDays(Number(e.target.value))}
                    className="w-full text-sm border border-border rounded-lg px-3 py-2"
                  >
                    <option value={1}>Last 24 hours</option>
                    <option value={7}>Last 7 days</option>
                    <option value={30}>Last 30 days</option>
                  </select>
                </>
              ) : (
                <>
                  <label className="block text-sm font-medium text-foreground mb-1">Limit</label>
                  <select
                    value={limit}
                    onChange={(e) => setLimit(Number(e.target.value))}
                    className="w-full text-sm border border-border rounded-lg px-3 py-2"
                  >
                    <option value={25}>25</option>
                    <option value={50}>50</option>
                    <option value={100}>100</option>
                    <option value={200}>200</option>
                  </select>
                </>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {view === "grouped" && (
        <Card>
          <CardHeader>
            <p className="text-sm text-muted-foreground">
              {loading || !grouped
                ? "Loading..."
                : `${grouped.totalGroups.toLocaleString("en-US")} groups from ${grouped.totalRows.toLocaleString("en-US")} rows in the last ${grouped.windowDays} day(s)${
                    grouped.groups.length < grouped.totalGroups
                      ? `, top ${grouped.groups.length} shown`
                      : ""
                  }${grouped.truncated ? ". The rarest messages were not read" : ""}`}
            </p>
          </CardHeader>
          <CardContent>
            {!loading && grouped?.groups.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">No log entries found.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left border-b border-border text-xs text-foreground">
                      <th className="pb-2 pr-4 font-semibold">Count</th>
                      <th className="pb-2 pr-4 font-semibold">Level</th>
                      <th className="pb-2 pr-4 font-semibold">Source</th>
                      <th className="pb-2 pr-4 font-semibold">Example</th>
                      <th className="pb-2 pr-4 font-semibold">First seen (UTC)</th>
                      <th className="pb-2 pr-4 font-semibold">Last seen (UTC)</th>
                      <th className="pb-2 font-semibold">
                        <span className="sr-only">Rows</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {grouped?.groups.map((group) => (
                      <tr
                        key={`${group.level}:${group.source}:${group.example}`}
                        className="border-b border-border last:border-0 align-top"
                      >
                        <td className="py-2 pr-4 tabular-nums font-medium">
                          {group.count.toLocaleString("en-US")}
                        </td>
                        <td className="py-2 pr-4">
                          <Badge variant={levelColors[group.level] || "default"}>
                            {group.level}
                          </Badge>
                        </td>
                        <td className="py-2 pr-4 font-mono text-xs text-foreground break-all">
                          {group.source}
                        </td>
                        <td className="py-2 pr-4 text-xs text-foreground break-words">
                          {group.example}
                        </td>
                        <td className="py-2 pr-4 text-xs text-muted-foreground whitespace-nowrap">
                          {formatSeen(group.firstSeenSec)}
                        </td>
                        <td className="py-2 pr-4 text-xs text-muted-foreground whitespace-nowrap">
                          {formatSeen(group.lastSeenSec)}
                        </td>
                        <td className="py-2 text-xs whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => showGroupRows(group)}
                            className="underline text-foreground"
                          >
                            See rows
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {view === "raw" && (
        <Card>
          <CardHeader>
            <p className="text-sm text-muted-foreground">
              {loading ? "Loading..." : `${logs.length} log entries`}
            </p>
          </CardHeader>
          <CardContent>
            {!loading && logs.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">No log entries found.</p>
            ) : (
              <div className="space-y-2">
                {logs.map((log) => (
                  <div key={log.id} className="border border-border rounded-lg overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setExpandedId(expandedId === log.id ? null : log.id)}
                      className="w-full text-left px-4 py-3 hover:bg-muted transition-colors"
                    >
                      <div className="flex items-start gap-3">
                        <Badge variant={levelColors[log.level] || "default"}>{log.level}</Badge>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">
                            {log.message}
                          </p>
                          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                            <span>{log.time}</span>
                            {log.source && (
                              <span className="font-mono bg-muted px-1.5 py-0.5 rounded">
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
                            {log.statusCode && <span>HTTP {log.statusCode}</span>}
                          </div>
                        </div>
                        <span className="text-muted-foreground text-sm">
                          {expandedId === log.id ? "▲" : "▼"}
                        </span>
                      </div>
                    </button>

                    {expandedId === log.id && (
                      <div className="px-4 py-3 border-t border-border bg-muted space-y-3">
                        <div className="flex items-center justify-between">
                          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm flex-1">
                            <div>
                              <span className="font-medium text-muted-foreground">ID: </span>
                              <span className="font-mono text-xs">{log.id}</span>
                            </div>
                            <div>
                              <span className="font-medium text-muted-foreground">Timestamp: </span>
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
                              <span className="font-medium text-muted-foreground">URL: </span>
                              <span className="font-mono text-xs break-all">{log.url}</span>
                            </div>
                          )}
                          {log.userAgent && (
                            <div className="col-span-2">
                              <span className="font-medium text-muted-foreground">
                                User Agent:{" "}
                              </span>
                              <span className="text-xs break-all">{log.userAgent}</span>
                            </div>
                          )}
                        </div>

                        {log.context && log.context !== "{}" && (
                          <div>
                            <p className="text-sm font-medium text-muted-foreground mb-1">
                              Context
                            </p>
                            <pre className="text-xs bg-card border border-border rounded p-2 overflow-x-auto">
                              {JSON.stringify(JSON.parse(log.context), null, 2)}
                            </pre>
                          </div>
                        )}

                        {log.stackTrace && (
                          <div>
                            <p className="text-sm font-medium text-muted-foreground mb-1">
                              Stack Trace
                            </p>
                            <pre className="text-xs bg-card border border-border rounded p-2 overflow-x-auto whitespace-pre-wrap">
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
      )}
    </div>
  );
}
