/**
 * Admin DLQ view for inbound emails. Lists recent rows in
 * inbound_emails (last 7 days by default) with status filters and a
 * "Retry" button for rows that ended up failed or stuck.
 *
 * Status colors: replied=green, forwarded=blue, processing=yellow,
 * received=gray (stuck if old), failed=red. The CF Workflows dashboard
 * is the source of truth for step-level detail; this page links out to
 * the instance page when workflow_instance_id is set.
 */

"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Check, ExternalLink, HelpCircle, RotateCw, X } from "lucide-react";

export const runtime = "edge";

const CF_ACCOUNT_ID = "e6011e48b7014ef83c77e3c767dac6cf";
const WORKFLOWS_DASH = `https://dash.cloudflare.com/${CF_ACCOUNT_ID}/workers/workflows/inbound-email/instance`;

interface InboundEmailRow {
  id: string;
  receivedAt: string;
  fromAddress: string;
  toAddress: string;
  subject: string | null;
  intent: string;
  status: string;
  workflowInstanceId: string | null;
  error: string | null;
  parsedUrl: string | null;
  attachmentCount: number;
  messageId: string | null;
  replyKind: string | null;
  resultingEvent: { id: string; slug: string; name: string } | null;
}

const statusBadge: Record<string, "success" | "info" | "warning" | "danger" | "default"> = {
  replied: "success",
  forwarded: "info",
  processing: "warning",
  waiting: "warning",
  received: "default",
  failed: "danger",
};

type DecisionAction = "applied" | "rejected" | "needs-more-info";

interface SenderRow {
  fromAddress: string;
  total: number;
  replied: number;
  failed: number;
  eventsCreated: number;
  approved: number;
  pending: number;
  rejected: number;
  approvalRate: number | null;
  noEventOk: number;
  topState: string | null;
  outOfArea: boolean;
  firstSeen: string;
  lastSeen: string;
  trustStatus: string;
  notes: string | null;
}

const trustBadge: Record<string, "success" | "warning" | "danger" | "default"> = {
  trusted: "success",
  watchlist: "warning",
  blocked: "danger",
  unknown: "default",
};

const INTENTS = ["", "submit", "correction", "support", "press", "unsubscribe", "unknown"];
const WINDOWS = [
  { hours: 24, label: "24h" },
  { hours: 168, label: "7d" },
  { hours: 720, label: "30d" },
];

export default function AdminInboundEmailsPage() {
  const [rows, setRows] = useState<InboundEmailRow[]>([]);
  const [senders, setSenders] = useState<SenderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [intentFilter, setIntentFilter] = useState<string>("");
  const [sinceHours, setSinceHours] = useState<number>(168);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [decideError, setDecideError] = useState<string | null>(null);
  const [sendersOpen, setSendersOpen] = useState(false);

  const fetchSenders = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/inbound-emails/senders?limit=50");
      if (!res.ok) return;
      const data = (await res.json()) as { senders: SenderRow[] };
      setSenders(data.senders);
    } catch (err) {
      console.error("Failed to fetch senders:", err);
    }
  }, []);

  useEffect(() => {
    fetchSenders();
  }, [fetchSenders]);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    setRetryError(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      if (intentFilter) params.set("intent", intentFilter);
      params.set("sinceHours", String(sinceHours));
      const res = await fetch(`/api/admin/inbound-emails?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as InboundEmailRow[];
      setRows(data);
    } catch (err) {
      console.error("Failed to fetch inbound emails:", err);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, intentFilter, sinceHours]);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  const handleRetry = async (messageRowId: string) => {
    setRetrying(messageRowId);
    setRetryError(null);
    try {
      const res = await fetch("/api/admin/inbound-emails/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageRowId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      await fetchRows();
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : String(err));
    } finally {
      setRetrying(null);
    }
  };

  const handleDecide = async (messageRowId: string, action: DecisionAction) => {
    // Optional note prompt — only when action calls for context. Skipping
    // the prompt entirely for the common "applied" case keeps the UX fast.
    let note: string | undefined;
    if (action === "rejected" || action === "needs-more-info") {
      const promptMsg =
        action === "needs-more-info"
          ? "What info do you need from the sender? (will be included in the reply)"
          : "Why rejecting? (optional — included in the reply if provided)";
      const entered = window.prompt(promptMsg) ?? "";
      note = entered.trim() || undefined;
    }
    setDeciding(messageRowId);
    setDecideError(null);
    try {
      const res = await fetch("/api/admin/inbound-emails/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageRowId, action, note }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      await fetchRows();
    } catch (err) {
      setDecideError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeciding(null);
    }
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Inbound Emails</h1>
        <p className="mt-1 text-gray-600">
          Messages received by the email() entrypoint and orchestrated by InboundEmailWorkflow.
          Click a row to see the error message; use the retry button to re-create the workflow for
          stuck or failed rows.
        </p>
      </div>

      {/* Sender-quality summary panel — collapsed by default. Shows per-
          sender aggregates (volume, approval rate, top state, out-of-area
          flag, operator trust annotation) so admins can spot real-event
          submitters vs out-of-area or bogus senders without manually
          scanning the row list. Trust annotation read-only here; write
          via the set_email_sender_trust MCP tool. */}
      <Card className="mb-6">
        <CardHeader className="cursor-pointer" onClick={() => setSendersOpen((v) => !v)}>
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">
                Sender summary ({senders.length})
              </h2>
              <p className="text-sm text-gray-500">
                Top submitters by volume, with outcome breakdown and trust annotation.
              </p>
            </div>
            <span className="text-sm text-gray-500">{sendersOpen ? "▾" : "▸"}</span>
          </div>
        </CardHeader>
        {sendersOpen && (
          <CardContent className="p-0">
            {senders.length === 0 ? (
              <p className="px-3 py-4 text-sm text-gray-500">No submit-intent senders yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium text-gray-700">Sender</th>
                    <th className="px-3 py-2 text-right font-medium text-gray-700">Inbound</th>
                    <th className="px-3 py-2 text-right font-medium text-gray-700">Events</th>
                    <th className="px-3 py-2 text-right font-medium text-gray-700">Approved</th>
                    <th className="px-3 py-2 text-right font-medium text-gray-700">Rejected</th>
                    <th className="px-3 py-2 text-right font-medium text-gray-700">Approval %</th>
                    <th className="px-3 py-2 text-left font-medium text-gray-700">Top state</th>
                    <th className="px-3 py-2 text-left font-medium text-gray-700">Trust</th>
                    <th className="px-3 py-2 text-left font-medium text-gray-700">Last seen</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {senders.map((s) => (
                    <tr key={s.fromAddress} className="hover:bg-gray-50">
                      <td className="px-3 py-2 break-all">{s.fromAddress}</td>
                      <td className="px-3 py-2 text-right">{s.total}</td>
                      <td className="px-3 py-2 text-right">{s.eventsCreated}</td>
                      <td className="px-3 py-2 text-right">{s.approved}</td>
                      <td className="px-3 py-2 text-right">{s.rejected}</td>
                      <td className="px-3 py-2 text-right text-gray-600">
                        {s.approvalRate === null ? "—" : `${Math.round(s.approvalRate * 100)}%`}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {s.topState ? (
                          <span className={s.outOfArea ? "text-red-600 font-medium" : ""}>
                            {s.topState}
                            {s.outOfArea && " ⚠"}
                          </span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <Badge variant={trustBadge[s.trustStatus] ?? "default"}>
                          {s.trustStatus}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-gray-500">
                        {new Date(s.lastSeen).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        )}
      </Card>

      <div className="flex flex-wrap gap-2 mb-4">
        <div className="flex gap-1">
          {["", "failed", "received", "processing", "replied", "forwarded"].map((s) => (
            <button
              key={s || "all"}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1 text-sm rounded ${
                statusFilter === s
                  ? "bg-blue-600 text-white"
                  : "bg-white border border-gray-200 text-gray-700 hover:bg-gray-50"
              }`}
            >
              {s || "all statuses"}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          {INTENTS.map((i) => (
            <button
              key={i || "any-intent"}
              onClick={() => setIntentFilter(i)}
              className={`px-3 py-1 text-sm rounded ${
                intentFilter === i
                  ? "bg-blue-600 text-white"
                  : "bg-white border border-gray-200 text-gray-700 hover:bg-gray-50"
              }`}
            >
              {i || "all intents"}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          {WINDOWS.map((w) => (
            <button
              key={w.hours}
              onClick={() => setSinceHours(w.hours)}
              className={`px-3 py-1 text-sm rounded ${
                sinceHours === w.hours
                  ? "bg-blue-600 text-white"
                  : "bg-white border border-gray-200 text-gray-700 hover:bg-gray-50"
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {retryError && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded">
          Retry failed: {retryError}
        </div>
      )}
      {decideError && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded">
          Decide failed: {decideError}
        </div>
      )}

      {loading ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-gray-500">Loading…</p>
          </CardContent>
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-gray-500">No inbound emails match the current filters.</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="text-sm text-gray-600 border-b">
            Showing {rows.length} most-recent message{rows.length === 1 ? "" : "s"}.
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="px-3 py-2 text-left font-medium text-gray-700">Received</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-700">From</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-700">Intent</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-700">Subject</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-700">Status</th>
                  <th className="px-3 py-2 text-right font-medium text-gray-700">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((row) => {
                  const canRetry = ["failed", "received", "processing"].includes(row.status);
                  const canDecide =
                    row.status === "waiting" &&
                    (row.intent === "correction" || row.intent === "press");
                  const expanded = expandedId === row.id;
                  return (
                    <Fragment key={row.id}>
                      <tr
                        className="hover:bg-gray-50 cursor-pointer"
                        onClick={() => setExpandedId(expanded ? null : row.id)}
                      >
                        <td className="px-3 py-2 whitespace-nowrap text-gray-600">
                          {new Date(row.receivedAt).toLocaleString()}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">{row.fromAddress}</td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <Badge variant="default">{row.intent}</Badge>
                        </td>
                        <td className="px-3 py-2 max-w-xs truncate">{row.subject ?? "—"}</td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <Badge variant={statusBadge[row.status] ?? "default"}>{row.status}</Badge>
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap text-right">
                          <div
                            className="inline-flex items-center gap-2"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {row.workflowInstanceId && (
                              <a
                                href={`${WORKFLOWS_DASH}/${row.workflowInstanceId}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
                              >
                                <ExternalLink className="w-3 h-3" />
                                CF dash
                              </a>
                            )}
                            {canRetry && (
                              <Button
                                size="sm"
                                variant="secondary"
                                type="button"
                                disabled={retrying === row.id}
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  handleRetry(row.id);
                                }}
                              >
                                <RotateCw
                                  className={`w-3 h-3 mr-1 ${
                                    retrying === row.id ? "animate-spin" : ""
                                  }`}
                                />
                                Retry
                              </Button>
                            )}
                            {canDecide && (
                              <>
                                <Button
                                  size="sm"
                                  variant="primary"
                                  type="button"
                                  disabled={deciding === row.id}
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    handleDecide(row.id, "applied");
                                  }}
                                >
                                  <Check className="w-3 h-3 mr-1" />
                                  Apply
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  type="button"
                                  disabled={deciding === row.id}
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    handleDecide(row.id, "needs-more-info");
                                  }}
                                >
                                  <HelpCircle className="w-3 h-3 mr-1" />
                                  Needs info
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  type="button"
                                  disabled={deciding === row.id}
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    handleDecide(row.id, "rejected");
                                  }}
                                >
                                  <X className="w-3 h-3 mr-1" />
                                  Reject
                                </Button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                      {expanded && (
                        <tr>
                          <td colSpan={6} className="px-3 py-3 bg-gray-50 text-xs text-gray-700">
                            <div className="space-y-1">
                              <div>
                                <span className="font-medium">To:</span> {row.toAddress}
                              </div>
                              {row.parsedUrl && (
                                <div>
                                  <span className="font-medium">Parsed URL:</span>{" "}
                                  <a
                                    href={row.parsedUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-blue-600 hover:underline break-all"
                                  >
                                    {row.parsedUrl}
                                  </a>
                                </div>
                              )}
                              <div>
                                <span className="font-medium">Attachments:</span>{" "}
                                {row.attachmentCount}
                              </div>
                              {row.replyKind && (
                                <div>
                                  <span className="font-medium">Reply kind:</span>{" "}
                                  <span
                                    className={
                                      row.replyKind === "already-exists"
                                        ? "font-mono text-blue-700"
                                        : "font-mono text-gray-700"
                                    }
                                  >
                                    {row.replyKind}
                                  </span>
                                </div>
                              )}
                              {row.resultingEvent && (
                                <div>
                                  <span className="font-medium">
                                    {row.replyKind === "already-exists"
                                      ? "Matched against:"
                                      : "Resulting event:"}
                                  </span>{" "}
                                  <a
                                    href={`/admin/events/${row.resultingEvent.id}`}
                                    className="text-blue-600 hover:underline"
                                  >
                                    {row.resultingEvent.name}
                                  </a>{" "}
                                  <a
                                    href={`/events/${row.resultingEvent.slug}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-gray-500 hover:underline"
                                  >
                                    (public)
                                  </a>
                                </div>
                              )}
                              {row.error && (
                                <div>
                                  <span className="font-medium text-red-600">Error:</span>{" "}
                                  <span className="text-red-700 font-mono">{row.error}</span>
                                </div>
                              )}
                              {row.messageId && (
                                <div className="font-mono text-gray-500 break-all">
                                  Message-ID: {row.messageId}
                                </div>
                              )}
                              {row.workflowInstanceId && (
                                <div className="font-mono text-gray-500">
                                  workflow_instance_id: {row.workflowInstanceId}
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
