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
import { formatTimestamp, formatDateMedium } from "@/lib/datetime";
import { SortHeader, sortBy, nextSort, type SortState } from "@/components/admin/sortable-table";

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
  // OPE-152 — did the auto-reply actually go out (email_send_ledger, OPE-151)?
  replyDelivery?: "sent" | "failed" | "stubbed" | null;
  fetchMethod: string | null;
  extractionMethod: string | null;
  resultingEvent: { id: string; slug: string; name: string } | null;
  // Phase C.1 / D.1 classifier fields. All nullable because pre-
  // classifier rows have no values.
  classifiedIntent: string | null;
  classifiedSubIntent: string | null;
  classifiedConfidence: number | null;
  classifiedRationale: string | null;
  classifierVersion: string | null;
  routingSource: string | null;
  flaggedForReview: number;
  parentEmailId: string | null;
}

// OPE-156 — full inbound body detail (fetched from /api/admin/inbound-emails/[id]).
interface InboundBodyDetail {
  id: string;
  bodyText: string | null;
  bodyHtml: string | null;
  bodyTextExcerpt: string | null;
  rawSize: number | null;
}

interface ClassifierStats {
  windowDays: number;
  since: string;
  accuracy: {
    classifierVersion: string | null;
    total: number;
    uncorrected: number;
    disagreements: number;
    accuracyPct: number | null;
  }[];
  disagreements: { originalIntent: string | null; correctedIntent: string; n: number }[];
  sources: { feedbackSource: string; n: number }[];
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

const INTENTS = [
  "",
  // Legacy address-based values
  "submit",
  "correction",
  "support",
  "press",
  "unsubscribe",
  "unknown",
  // Classifier-introduced values (drizzle/0079)
  "new_event",
  "source_suggestion",
  "claim_request",
  "vendor_inquiry",
  "spam",
  "unclear",
  "multi",
];

// Same union used by the reclassify endpoint's whitelist. Kept in sync
// with mcp-server/src/email-intents.ts EmailIntent.
const RECLASSIFY_INTENTS = INTENTS.filter((i) => i.length > 0);
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
  // OPE-163 — inline reply composer (opens inside the expanded detail).
  const [replyOpenId, setReplyOpenId] = useState<string | null>(null);
  const [replySubject, setReplySubject] = useState("");
  const [replyBody, setReplyBody] = useState("");
  const [replyConfirm, setReplyConfirm] = useState(false);
  const [replySending, setReplySending] = useState(false);
  const [replyMsg, setReplyMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  // OPE-178 — "log an external reply" composer (records a send made off-platform,
  // e.g. from Gmail; never sends email).
  const [logExtOpenId, setLogExtOpenId] = useState<string | null>(null);
  const [logExtTo, setLogExtTo] = useState("");
  const [logExtSubject, setLogExtSubject] = useState("");
  const [logExtBody, setLogExtBody] = useState("");
  const [logExtProvider, setLogExtProvider] = useState("gmail");
  const [logExtSending, setLogExtSending] = useState(false);
  const [logExtMsg, setLogExtMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  // OPE-156 — full message body, fetched on demand when a row is expanded
  // (kept out of the list payload to keep it lean). Cached per row id.
  const [bodyDetail, setBodyDetail] = useState<
    Record<string, InboundBodyDetail | "loading" | "error">
  >({});
  const [rawBodyView, setRawBodyView] = useState(false);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [decideError, setDecideError] = useState<string | null>(null);
  // OPE-157 — client-side column sort (default: newest first).
  const [sort, setSort] = useState<SortState>({ col: "receivedAt", dir: "desc" });
  const onSort = (col: string) => setSort((s) => nextSort(s, col));
  const sortInboundValue = (r: InboundEmailRow, col: string): string | number | null => {
    switch (col) {
      case "receivedAt":
        return Date.parse(r.receivedAt);
      case "fromAddress":
        return r.fromAddress;
      case "intent":
        return r.intent;
      case "subject":
        return r.subject;
      case "status":
        return r.status;
      default:
        return null;
    }
  };
  // Item 19 (2026-05-25) — admin-driven manual-salvage notification flow.
  const [salvaging, setSalvaging] = useState<string | null>(null);
  const [salvageError, setSalvageError] = useState<string | null>(null);
  const [sendersOpen, setSendersOpen] = useState(false);
  const [stats, setStats] = useState<ClassifierStats | null>(null);
  const [reclassifying, setReclassifying] = useState<string | null>(null);
  const [reclassifyError, setReclassifyError] = useState<string | null>(null);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/inbound-emails/classifier-stats?days=30");
      if (!res.ok) return;
      setStats((await res.json()) as ClassifierStats);
    } catch (err) {
      console.error("Failed to fetch classifier stats:", err);
    }
  }, []);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

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

  // OPE-156 — expand/collapse a row, fetching its full body on first open.
  const toggleExpand = useCallback(
    async (id: string) => {
      setRawBodyView(false);
      if (expandedId === id) {
        setExpandedId(null);
        return;
      }
      setExpandedId(id);
      if (bodyDetail[id]) return; // cached
      setBodyDetail((d) => ({ ...d, [id]: "loading" }));
      try {
        const res = await fetch(`/api/admin/inbound-emails/${encodeURIComponent(id)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = (await res.json()) as InboundBodyDetail;
        setBodyDetail((d) => ({ ...d, [id]: j }));
      } catch {
        setBodyDetail((d) => ({ ...d, [id]: "error" }));
      }
    },
    [expandedId, bodyDetail]
  );

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  // OPE-163 — open the reply composer for a row, prefilling the subject.
  const openReply = useCallback((row: InboundEmailRow) => {
    setReplyOpenId(row.id);
    setReplySubject(`Re: ${row.subject || "your message"}`.slice(0, 200));
    setReplyBody("");
    setReplyConfirm(false);
    setReplyMsg(null);
  }, []);

  // OPE-163 — send the reply (after the confirm step). The endpoint enqueues via
  // the transactional pipeline; a 409 means replies aren't enabled yet.
  const sendReply = useCallback(
    async (rowId: string) => {
      setReplySending(true);
      setReplyMsg(null);
      try {
        const res = await fetch(`/api/admin/inbound-emails/${encodeURIComponent(rowId)}/reply`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subject: replySubject, body: replyBody }),
        });
        const j = (await res.json().catch(() => ({}))) as {
          to?: string;
          error?: string;
          message?: string;
        };
        if (!res.ok) {
          setReplyMsg({ kind: "err", text: j.message || j.error || `HTTP ${res.status}` });
          setReplyConfirm(false);
        } else {
          setReplyMsg({
            kind: "ok",
            text: `Reply queued to ${j.to}. Check the Sent viewer for delivery.`,
          });
          setReplyConfirm(false);
          setReplyBody("");
          void fetchRows();
        }
      } catch (e) {
        setReplyMsg({ kind: "err", text: e instanceof Error ? e.message : "Failed to send." });
        setReplyConfirm(false);
      } finally {
        setReplySending(false);
      }
    },
    [replySubject, replyBody, fetchRows]
  );

  // OPE-178 — open/close + submit the "log external reply" composer.
  const openLogExt = useCallback((row: InboundEmailRow) => {
    setLogExtOpenId(row.id);
    setLogExtTo(row.fromAddress);
    setLogExtSubject(`Re: ${row.subject || "your message"}`.slice(0, 200));
    setLogExtBody("");
    setLogExtProvider("gmail");
    setLogExtMsg(null);
  }, []);

  const logExternal = useCallback(
    async (rowId: string) => {
      setLogExtSending(true);
      setLogExtMsg(null);
      try {
        const res = await fetch(
          `/api/admin/inbound-emails/${encodeURIComponent(rowId)}/log-external-reply`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              recipient: logExtTo,
              subject: logExtSubject,
              body: logExtBody,
              provider: logExtProvider,
            }),
          }
        );
        const j = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        if (!res.ok) {
          setLogExtMsg({ kind: "err", text: j.message || j.error || `HTTP ${res.status}` });
        } else {
          setLogExtMsg({ kind: "ok", text: "Logged. It now shows in the email history." });
          setLogExtBody("");
          void fetchRows();
        }
      } catch (e) {
        setLogExtMsg({ kind: "err", text: e instanceof Error ? e.message : "Failed to log." });
      } finally {
        setLogExtSending(false);
      }
    },
    [logExtTo, logExtSubject, logExtBody, logExtProvider, fetchRows]
  );

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

  const handleReclassify = async (rowId: string, correctedIntent: string) => {
    setReclassifying(rowId);
    setReclassifyError(null);
    try {
      const adminNote =
        window.prompt("Optional note (visible in admin_actions audit):") || undefined;
      const alsoRerunWorkflow = window.confirm(
        "Also re-run the workflow with the corrected intent? (OK = re-run, Cancel = just relabel)"
      );
      const res = await fetch(`/api/admin/inbound-emails/${encodeURIComponent(rowId)}/reclassify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ correctedIntent, adminNote, alsoRerunWorkflow }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      await Promise.all([fetchRows(), fetchStats()]);
    } catch (err) {
      setReclassifyError(err instanceof Error ? err.message : String(err));
    } finally {
      setReclassifying(null);
    }
  };

  const handleMarkCorrect = async (rowId: string) => {
    setReclassifying(rowId);
    setReclassifyError(null);
    try {
      const res = await fetch(
        `/api/admin/inbound-emails/${encodeURIComponent(rowId)}/mark-correct`,
        { method: "POST" }
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      await Promise.all([fetchRows(), fetchStats()]);
    } catch (err) {
      setReclassifyError(err instanceof Error ? err.message : String(err));
    } finally {
      setReclassifying(null);
    }
  };

  const handleFlagToggle = async (rowId: string, flagged: boolean) => {
    setReclassifying(rowId);
    setReclassifyError(null);
    try {
      const res = await fetch(
        `/api/admin/inbound-emails/${encodeURIComponent(rowId)}/flag-for-review`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ flagged }),
        }
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      await fetchRows();
    } catch (err) {
      setReclassifyError(err instanceof Error ? err.message : String(err));
    } finally {
      setReclassifying(null);
    }
  };

  // Item 19 (2026-05-25) — admin manually creates events from a failed
  // inbound email and notifies the submitter. Prompt asks for comma-
  // separated event UUIDs; backend validates each exists, links them to
  // the inbound row, and queues one summary email via salvage-notification.ts.
  const handleSalvage = async (messageRowId: string) => {
    const entered = window.prompt(
      "Salvage: enter event UUID(s) created from this email (comma-separated, in display order).\nExample: 72de289f-..., 9424df85-...\nThe submitter will receive one email listing all events."
    );
    if (!entered) return;
    const eventIds = entered
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    if (eventIds.length === 0) return;
    setSalvaging(messageRowId);
    setSalvageError(null);
    try {
      const res = await fetch(`/api/admin/inbound-emails/${messageRowId}/salvage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_ids: eventIds }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        notify_outcome?: string;
        events_in_email?: number;
      };
      if (!res.ok) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      window.alert(
        body.notify_outcome === "sent"
          ? `Linked ${body.events_in_email} event(s) and emailed the submitter.`
          : `Linked, but notification was ${body.notify_outcome}.`
      );
      await fetchRows();
    } catch (err) {
      setSalvageError(err instanceof Error ? err.message : String(err));
    } finally {
      setSalvaging(null);
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
        <h1 className="text-2xl font-bold text-foreground">Inbound Emails</h1>
        <p className="mt-1 text-muted-foreground">
          Messages received by the email() entrypoint and orchestrated by InboundEmailWorkflow.
          Click a row to see the error message; use the retry button to re-create the workflow for
          stuck or failed rows.
        </p>
        {stats && stats.accuracy.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
            <span className="text-muted-foreground">
              Classifier accuracy (last {stats.windowDays}d):
            </span>
            {stats.accuracy.map((a) => (
              <span
                key={a.classifierVersion ?? "unversioned"}
                className="inline-flex items-center gap-1 rounded bg-muted px-2 py-1"
              >
                <span className="font-mono text-xs text-muted-foreground">
                  {a.classifierVersion ?? "—"}
                </span>
                <span
                  className={
                    a.accuracyPct === null
                      ? "text-muted-foreground"
                      : a.accuracyPct >= 80
                        ? "font-medium text-green-700"
                        : a.accuracyPct >= 60
                          ? "font-medium text-yellow-700"
                          : "font-medium text-red-700"
                  }
                >
                  {a.accuracyPct === null ? "—" : `${a.accuracyPct}%`}
                </span>
                <span className="text-muted-foreground">
                  ({a.uncorrected}/{a.total})
                </span>
              </span>
            ))}
            <a
              href="/admin/classifier-accuracy"
              className="ml-1 text-xs text-royal hover:underline"
            >
              weekly trend →
            </a>
          </div>
        )}
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
              <h2 className="text-lg font-semibold text-foreground">
                Sender summary ({senders.length})
              </h2>
              <p className="text-sm text-muted-foreground">
                Top submitters by volume, with outcome breakdown and trust annotation.
              </p>
            </div>
            <span className="text-sm text-muted-foreground">{sendersOpen ? "▾" : "▸"}</span>
          </div>
        </CardHeader>
        {sendersOpen && (
          <CardContent className="p-0">
            {senders.length === 0 ? (
              <p className="px-3 py-4 text-sm text-muted-foreground">
                No submit-intent senders yet.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-muted border-b">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium text-foreground">Sender</th>
                    <th className="px-3 py-2 text-right font-medium text-foreground">Inbound</th>
                    <th className="px-3 py-2 text-right font-medium text-foreground">Events</th>
                    <th className="px-3 py-2 text-right font-medium text-foreground">Approved</th>
                    <th className="px-3 py-2 text-right font-medium text-foreground">Rejected</th>
                    <th className="px-3 py-2 text-right font-medium text-foreground">Approval %</th>
                    <th className="px-3 py-2 text-left font-medium text-foreground">Top state</th>
                    <th className="px-3 py-2 text-left font-medium text-foreground">Trust</th>
                    <th className="px-3 py-2 text-left font-medium text-foreground">Last seen</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {senders.map((s) => (
                    <tr key={s.fromAddress} className="hover:bg-muted">
                      <td className="px-3 py-2 break-all">{s.fromAddress}</td>
                      <td className="px-3 py-2 text-right">{s.total}</td>
                      <td className="px-3 py-2 text-right">{s.eventsCreated}</td>
                      <td className="px-3 py-2 text-right">{s.approved}</td>
                      <td className="px-3 py-2 text-right">{s.rejected}</td>
                      <td className="px-3 py-2 text-right text-muted-foreground">
                        {s.approvalRate === null ? "—" : `${Math.round(s.approvalRate * 100)}%`}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {s.topState ? (
                          <span className={s.outOfArea ? "text-red-600 font-medium" : ""}>
                            {s.topState}
                            {s.outOfArea && " ⚠"}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <Badge variant={trustBadge[s.trustStatus] ?? "default"}>
                          {s.trustStatus}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                        {formatDateMedium(s.lastSeen)}
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
                  ? "bg-secondary text-secondary-foreground"
                  : "bg-card border border-border text-foreground hover:bg-muted"
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
                  ? "bg-secondary text-secondary-foreground"
                  : "bg-card border border-border text-foreground hover:bg-muted"
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
                  ? "bg-secondary text-secondary-foreground"
                  : "bg-card border border-border text-foreground hover:bg-muted"
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
      {salvageError && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded">
          Salvage failed: {salvageError}
        </div>
      )}
      {reclassifyError && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded">
          Reclassify failed: {reclassifyError}
        </div>
      )}

      {loading ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">Loading…</p>
          </CardContent>
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">No inbound emails match the current filters.</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="text-sm text-muted-foreground border-b">
            Showing {rows.length} most-recent message{rows.length === 1 ? "" : "s"}.
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="bg-muted border-b">
                <tr>
                  <SortHeader
                    label="Received"
                    col="receivedAt"
                    sort={sort}
                    onSort={onSort}
                    className="text-left font-medium text-foreground"
                  />
                  <SortHeader
                    label="From"
                    col="fromAddress"
                    sort={sort}
                    onSort={onSort}
                    className="text-left font-medium text-foreground"
                  />
                  <SortHeader
                    label="Intent"
                    col="intent"
                    sort={sort}
                    onSort={onSort}
                    className="text-left font-medium text-foreground"
                  />
                  <SortHeader
                    label="Subject"
                    col="subject"
                    sort={sort}
                    onSort={onSort}
                    className="text-left font-medium text-foreground"
                  />
                  <SortHeader
                    label="Status"
                    col="status"
                    sort={sort}
                    onSort={onSort}
                    className="text-left font-medium text-foreground"
                  />
                  <th className="px-3 py-2 text-right font-medium text-foreground">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {sortBy(rows, sort.col, sort.dir, sortInboundValue).map((row) => {
                  const canRetry = ["failed", "received", "processing"].includes(row.status);
                  const canDecide =
                    row.status === "waiting" &&
                    (row.intent === "correction" || row.intent === "press");
                  const expanded = expandedId === row.id;
                  return (
                    <Fragment key={row.id}>
                      <tr
                        className="hover:bg-muted cursor-pointer"
                        onClick={() => void toggleExpand(row.id)}
                      >
                        <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                          {formatTimestamp(row.receivedAt)}
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
                                className="inline-flex items-center gap-1 text-xs text-royal hover:underline"
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
                            {/* Item 19 — manual salvage: admin paste event IDs
                                they hand-created from this email, submitter
                                gets one notification listing them all. */}
                            {canRetry && (
                              <Button
                                size="sm"
                                variant="outline"
                                type="button"
                                disabled={salvaging === row.id}
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  handleSalvage(row.id);
                                }}
                                title="Manually link events you created from this email and notify the submitter"
                              >
                                <Check className="w-3 h-3 mr-1" />
                                {salvaging === row.id ? "Salvaging…" : "Salvage"}
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
                          <td colSpan={6} className="px-3 py-3 bg-muted text-xs text-foreground">
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
                                    className="text-royal hover:underline break-all"
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
                                        ? "font-mono text-navy"
                                        : "font-mono text-foreground"
                                    }
                                  >
                                    {row.replyKind}
                                  </span>
                                </div>
                              )}
                              {row.replyDelivery && (
                                <div>
                                  <span className="font-medium">Reply delivery:</span>{" "}
                                  <span
                                    className={
                                      row.replyDelivery === "sent"
                                        ? "font-mono text-green-700"
                                        : row.replyDelivery === "failed"
                                          ? "font-mono text-terracotta"
                                          : "font-mono text-amber-dark"
                                    }
                                  >
                                    {row.replyDelivery === "sent" ? "delivered" : row.replyDelivery}
                                  </span>{" "}
                                  <a
                                    href={`/admin/sent-emails?inboundEmailId=${encodeURIComponent(row.id)}`}
                                    className="text-navy hover:underline text-xs"
                                  >
                                    view send →
                                  </a>
                                </div>
                              )}
                              {(row.extractionMethod || row.fetchMethod) && (
                                <div className="flex gap-3">
                                  {row.extractionMethod && (
                                    <span>
                                      <span className="font-medium">Extracted via:</span>{" "}
                                      <span
                                        className={
                                          row.extractionMethod === "json-ld"
                                            ? "font-mono text-emerald-700"
                                            : "font-mono text-foreground"
                                        }
                                      >
                                        {row.extractionMethod}
                                      </span>
                                    </span>
                                  )}
                                  {row.fetchMethod && (
                                    <span>
                                      <span className="font-medium">Fetched via:</span>{" "}
                                      <span className="font-mono text-foreground">
                                        {row.fetchMethod}
                                      </span>
                                    </span>
                                  )}
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
                                    className="text-royal hover:underline"
                                  >
                                    {row.resultingEvent.name}
                                  </a>{" "}
                                  <a
                                    href={`/events/${row.resultingEvent.slug}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-muted-foreground hover:underline"
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
                                <div className="font-mono text-muted-foreground break-all">
                                  Message-ID: {row.messageId}
                                </div>
                              )}
                              {row.workflowInstanceId && (
                                <div className="font-mono text-muted-foreground">
                                  workflow_instance_id: {row.workflowInstanceId}
                                </div>
                              )}
                              {row.parentEmailId && (
                                <div className="font-mono text-muted-foreground">
                                  parent_email_id: {row.parentEmailId}
                                </div>
                              )}

                              {/* OPE-156 — full received body, fetched on expand.
                                  HTML preview (sandboxed iframe) with a raw/text
                                  toggle; pre-OPE-156 rows have no stored body and
                                  degrade to the excerpt with an "excerpt only"
                                  indicator. */}
                              <div className="mt-3 pt-3 border-t border-border">
                                <div className="flex items-center gap-3 mb-2">
                                  <span className="font-medium">Message body</span>
                                  {(() => {
                                    const d = bodyDetail[row.id];
                                    return d && d !== "loading" && d !== "error" && d.bodyHtml ? (
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setRawBodyView((v) => !v);
                                        }}
                                        className="text-royal hover:underline text-xs"
                                      >
                                        {rawBodyView ? "Preview" : "Raw HTML"}
                                      </button>
                                    ) : null;
                                  })()}
                                </div>
                                {(() => {
                                  const d = bodyDetail[row.id];
                                  if (!d || d === "loading")
                                    return <p className="text-muted-foreground">Loading…</p>;
                                  if (d === "error")
                                    return <p className="text-terracotta">Failed to load body.</p>;
                                  if (d.bodyHtml || d.bodyText) {
                                    return d.bodyHtml && !rawBodyView ? (
                                      <iframe
                                        sandbox=""
                                        title="Received email body"
                                        srcDoc={d.bodyHtml}
                                        className="w-full h-96 bg-white border border-border rounded"
                                      />
                                    ) : (
                                      <pre className="whitespace-pre-wrap break-words text-xs bg-card border border-border rounded p-3 max-h-96 overflow-auto">
                                        {rawBodyView && d.bodyHtml ? d.bodyHtml : d.bodyText}
                                      </pre>
                                    );
                                  }
                                  // Pre-OPE-156 row — only the excerpt survives.
                                  return (
                                    <div>
                                      <Badge variant="warning" className="mb-1">
                                        excerpt only
                                      </Badge>
                                      <pre className="whitespace-pre-wrap break-words text-xs bg-card border border-border rounded p-3 max-h-96 overflow-auto">
                                        {d.bodyTextExcerpt || "(no body captured)"}
                                      </pre>
                                    </div>
                                  );
                                })()}
                              </div>

                              {/* OPE-163 — reply composer (send from support@,
                                  threaded + ledgered by the endpoint). Two-step
                                  confirm before it actually sends. */}
                              <div className="mt-3 pt-3 border-t border-border">
                                {replyOpenId === row.id ? (
                                  <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
                                    <div className="flex items-center justify-between">
                                      <span className="font-medium">Reply</span>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setReplyOpenId(null);
                                          setReplyConfirm(false);
                                          setReplyMsg(null);
                                        }}
                                        className="text-xs text-muted-foreground hover:text-foreground"
                                      >
                                        Close
                                      </button>
                                    </div>
                                    <div className="text-xs text-muted-foreground">
                                      To <span className="font-mono">{row.fromAddress}</span> · from{" "}
                                      <span className="font-mono">support@meetmeatthefair.com</span>
                                    </div>
                                    <input
                                      type="text"
                                      value={replySubject}
                                      onChange={(e) => setReplySubject(e.target.value)}
                                      className="w-full rounded border border-border bg-card px-2 py-1 text-sm"
                                      placeholder="Subject"
                                    />
                                    <textarea
                                      value={replyBody}
                                      onChange={(e) => setReplyBody(e.target.value)}
                                      rows={6}
                                      className="w-full rounded border border-border bg-card px-2 py-1 text-sm"
                                      placeholder="Write your reply…"
                                    />
                                    {replyMsg && (
                                      <div
                                        className={`text-xs ${replyMsg.kind === "ok" ? "text-green-700" : "text-terracotta"}`}
                                      >
                                        {replyMsg.text}
                                      </div>
                                    )}
                                    {replyConfirm ? (
                                      <div className="flex items-center gap-2">
                                        <span className="text-xs text-amber-dark">
                                          Send this reply to {row.fromAddress}?
                                        </span>
                                        <button
                                          type="button"
                                          disabled={replySending}
                                          onClick={() => void sendReply(row.id)}
                                          className="rounded bg-navy px-3 py-1 text-xs text-white disabled:opacity-50"
                                        >
                                          {replySending ? "Sending…" : "Confirm send"}
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => setReplyConfirm(false)}
                                          className="text-xs text-muted-foreground hover:text-foreground"
                                        >
                                          Back
                                        </button>
                                      </div>
                                    ) : (
                                      <button
                                        type="button"
                                        disabled={!replyBody.trim() || !replySubject.trim()}
                                        onClick={() => {
                                          setReplyMsg(null);
                                          setReplyConfirm(true);
                                        }}
                                        className="rounded bg-navy px-3 py-1 text-xs text-white disabled:opacity-50"
                                      >
                                        Send reply…
                                      </button>
                                    )}
                                  </div>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      openReply(row);
                                    }}
                                    className="rounded border border-navy px-3 py-1 text-xs text-navy hover:bg-navy hover:text-white"
                                  >
                                    Reply
                                  </button>
                                )}
                              </div>

                              {/* OPE-178 — log a reply that was sent OFF-platform
                                  (e.g. from Gmail) so the email history is complete.
                                  Records a ledger row only; never sends email. */}
                              <div className="mt-2">
                                {logExtOpenId === row.id ? (
                                  <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
                                    <div className="flex items-center justify-between">
                                      <span className="font-medium">
                                        Log an external reply (sent elsewhere)
                                      </span>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setLogExtOpenId(null);
                                          setLogExtMsg(null);
                                        }}
                                        className="text-xs text-muted-foreground hover:text-foreground"
                                      >
                                        Close
                                      </button>
                                    </div>
                                    <div className="flex gap-2">
                                      <input
                                        type="text"
                                        value={logExtTo}
                                        onChange={(e) => setLogExtTo(e.target.value)}
                                        className="flex-1 rounded border border-border bg-card px-2 py-1 text-sm"
                                        placeholder="Recipient"
                                      />
                                      <input
                                        type="text"
                                        value={logExtProvider}
                                        onChange={(e) => setLogExtProvider(e.target.value)}
                                        className="w-28 rounded border border-border bg-card px-2 py-1 text-sm"
                                        placeholder="Provider"
                                        title="Where it was sent from, e.g. gmail"
                                      />
                                    </div>
                                    <input
                                      type="text"
                                      value={logExtSubject}
                                      onChange={(e) => setLogExtSubject(e.target.value)}
                                      className="w-full rounded border border-border bg-card px-2 py-1 text-sm"
                                      placeholder="Subject"
                                    />
                                    <textarea
                                      value={logExtBody}
                                      onChange={(e) => setLogExtBody(e.target.value)}
                                      rows={4}
                                      className="w-full rounded border border-border bg-card px-2 py-1 text-sm"
                                      placeholder="Paste what you sent…"
                                    />
                                    {logExtMsg && (
                                      <div
                                        className={`text-xs ${logExtMsg.kind === "ok" ? "text-green-700" : "text-terracotta"}`}
                                      >
                                        {logExtMsg.text}
                                      </div>
                                    )}
                                    <button
                                      type="button"
                                      disabled={
                                        logExtSending || !logExtTo.trim() || !logExtBody.trim()
                                      }
                                      onClick={() => void logExternal(row.id)}
                                      className="rounded border border-border px-3 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-50"
                                    >
                                      {logExtSending ? "Logging…" : "Log this reply"}
                                    </button>
                                  </div>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      openLogExt(row);
                                    }}
                                    className="text-xs text-muted-foreground underline hover:text-foreground"
                                  >
                                    Log an external reply
                                  </button>
                                )}
                              </div>

                              {/* Phase D.1 classifier-metadata panel + admin
                                  affordances. Only shown when the row has
                                  classifier data (post-C.1 rows). */}
                              {row.classifiedIntent && (
                                <div className="mt-3 pt-3 border-t border-border space-y-1">
                                  <div className="flex flex-wrap items-center gap-2 text-xs">
                                    <span className="font-medium">Classifier:</span>
                                    <Badge variant="default">{row.classifiedIntent}</Badge>
                                    {row.classifiedSubIntent && (
                                      <Badge variant="info">{row.classifiedSubIntent}</Badge>
                                    )}
                                    {row.classifiedConfidence !== null && (
                                      <span
                                        className={
                                          row.classifiedConfidence >= 0.85
                                            ? "text-green-700"
                                            : "text-yellow-700"
                                        }
                                      >
                                        {(row.classifiedConfidence * 100).toFixed(0)}%
                                      </span>
                                    )}
                                    {row.routingSource && (
                                      <span className="font-mono text-muted-foreground">
                                        {row.routingSource}
                                      </span>
                                    )}
                                    {row.classifierVersion && (
                                      <span className="font-mono text-muted-foreground">
                                        {row.classifierVersion}
                                      </span>
                                    )}
                                    {row.flaggedForReview === 1 && (
                                      <Badge variant="warning">flagged</Badge>
                                    )}
                                  </div>
                                  {row.classifiedRationale && (
                                    <div className="text-muted-foreground italic">
                                      &ldquo;{row.classifiedRationale}&rdquo;
                                    </div>
                                  )}
                                  <div className="flex flex-wrap items-center gap-2 pt-2">
                                    <label className="flex items-center gap-1 text-xs">
                                      <span>Reclassify:</span>
                                      <select
                                        className="rounded border border-border px-2 py-0.5 text-xs"
                                        defaultValue=""
                                        disabled={reclassifying === row.id}
                                        onClick={(e) => e.stopPropagation()}
                                        onChange={(e) => {
                                          const v = e.target.value;
                                          e.target.value = "";
                                          if (v) handleReclassify(row.id, v);
                                        }}
                                      >
                                        <option value="">— pick —</option>
                                        {RECLASSIFY_INTENTS.map((i) => (
                                          <option key={i} value={i}>
                                            {i}
                                          </option>
                                        ))}
                                      </select>
                                    </label>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      type="button"
                                      disabled={reclassifying === row.id}
                                      onClick={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        handleMarkCorrect(row.id);
                                      }}
                                    >
                                      Mark correct
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      type="button"
                                      disabled={reclassifying === row.id}
                                      onClick={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        handleFlagToggle(row.id, row.flaggedForReview !== 1);
                                      }}
                                    >
                                      {row.flaggedForReview === 1 ? "Unflag" : "Flag for review"}
                                    </Button>
                                  </div>
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
