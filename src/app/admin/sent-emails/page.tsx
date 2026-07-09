/**
 * OPE-152 — Admin "Sent Emails" view: the outbound counterpart to
 * /admin/inbound-emails. Lists email_send_ledger (OPE-151) so an admin can see
 * every send — auto-replies, claim invites, vendor outreach, system notices,
 * transactional — INCLUDING failures. Searchable by recipient; filterable by
 * outcome. Auto-reply rows link back to the triggering inbound email (threading).
 *
 * Read-only viewer (no compose/send). Admin-gated by the /admin layout guard.
 */

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Search, RotateCw, ExternalLink } from "lucide-react";
import { formatTimestamp } from "@/lib/datetime";

interface SentEmailRow {
  messageId: string;
  sentAt: string;
  recipient: string | null;
  source: string | null;
  subject: string | null;
  status: "sent" | "failed" | "stubbed";
  provider: string | null;
  providerMessageId: string | null;
  error: string | null;
  inboundEmailId: string | null;
  inbound: { fromAddress: string; subject: string | null } | null;
}

type StatusFilter = "all" | "sent" | "failed" | "stubbed";

const STATUS_VARIANT: Record<SentEmailRow["status"], "success" | "danger" | "warning"> = {
  sent: "success",
  failed: "danger",
  stubbed: "warning",
};

export default function SentEmailsPage() {
  const [rows, setRows] = useState<SentEmailRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const sp = new URLSearchParams({ sinceHours: "8760", limit: "300" });
      if (q.trim()) sp.set("q", q.trim());
      if (status !== "all") sp.set("status", status);
      const res = await fetch(`/api/admin/sent-emails?${sp.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setRows((await res.json()) as SentEmailRow[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [q, status]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-2xl font-bold text-foreground">Sent Emails</h1>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RotateCw className={`w-4 h-4 mr-1 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        Every outbound send recorded in <code>email_send_ledger</code> (OPE-151) — auto-replies,
        claim invites, vendor outreach, system notices, and transactional mail, including failures.
        Read-only.
      </p>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void load();
          }}
          className="relative"
        >
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by recipient address…"
            aria-label="Search sent emails by recipient"
            className="w-72 rounded-md border border-border bg-card pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy"
          />
        </form>
        <div className="flex gap-1">
          {(["all", "sent", "failed", "stubbed"] as StatusFilter[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatus(s)}
              className={`rounded-md border px-3 py-1.5 text-sm capitalize transition ${
                status === s
                  ? "border-navy bg-navy text-white"
                  : "border-border bg-card text-muted-foreground hover:border-navy"
              }`}
            >
              {s}
              {s !== "all" && counts[s] ? ` (${counts[s]})` : ""}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <Card className="mb-4 border-terracotta/40">
          <CardContent className="py-3 text-sm text-terracotta">Error: {error}</CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="text-sm text-muted-foreground">
          {loading
            ? "Loading…"
            : `${rows.length} send${rows.length === 1 ? "" : "s"} (last 12 months)`}
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          {!loading && rows.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">No sends match.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Sent</th>
                  <th className="px-3 py-2">Recipient</th>
                  <th className="px-3 py-2">Kind</th>
                  <th className="px-3 py-2">Subject</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Provider</th>
                  <th className="px-3 py-2">Thread</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.messageId} className="border-b border-border/60 align-top">
                    <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                      {formatTimestamp(r.sentAt)}
                    </td>
                    <td className="px-3 py-2 break-all">{r.recipient ?? "—"}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <code className="text-xs">{r.source ?? "—"}</code>
                    </td>
                    <td className="px-3 py-2 max-w-xs truncate" title={r.subject ?? ""}>
                      {r.subject ?? "—"}
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant={STATUS_VARIANT[r.status]} className="text-xs">
                        {r.status}
                      </Badge>
                      {r.status === "failed" && r.error && (
                        <p className="mt-1 text-xs text-terracotta max-w-xs break-words">
                          {r.error}
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-xs text-muted-foreground">
                      {r.provider ?? "—"}
                      {r.providerMessageId && (
                        <span className="block break-all" title={r.providerMessageId}>
                          {r.providerMessageId.slice(0, 16)}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {r.inboundEmailId ? (
                        <Link
                          href={`/admin/inbound-emails?focus=${encodeURIComponent(r.inboundEmailId)}`}
                          className="inline-flex items-center gap-1 text-navy hover:underline"
                          title={
                            r.inbound
                              ? `Reply to ${r.inbound.fromAddress}: ${r.inbound.subject ?? ""}`
                              : "Triggering inbound email"
                          }
                        >
                          <ExternalLink className="w-3 h-3" />
                          {r.inbound?.fromAddress ?? "inbound"}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
