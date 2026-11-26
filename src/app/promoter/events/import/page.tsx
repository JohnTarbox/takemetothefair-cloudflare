"use client";

/**
 * OPE-1618 — import a season of shows from one spreadsheet.
 *
 * Upload → the server previews every row (new / matches your event / error) →
 * the promoter ticks what to commit → commit. Nothing is saved until "Import".
 * Previews and commits are paged (the server's D1 query budget); this page
 * loops over the pages so the promoter sees one table.
 */
import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Download, FileSpreadsheet, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

type Status = "error" | "already_imported" | "match" | "new";
interface PreviewRow {
  row: number;
  status: Status;
  name: string | null;
  start_date: string | null;
  errors: string[];
  warnings?: string[];
  event?: { id: string; slug: string; name: string; status: string };
  changes?: Record<string, { current: string | null; proposed: string | null }>;
}
interface CommitResult {
  row: number;
  outcome: "created" | "update_staged" | "skipped";
  event_id?: string;
  reason?: string;
}

const STATUS_LABEL: Record<Status, string> = {
  new: "New event",
  match: "Matches your event",
  already_imported: "Already imported",
  error: "Needs fixing",
};

async function post(file: File, fields: Record<string, string>) {
  const fd = new FormData();
  fd.set("file", file);
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  const res = await fetch("/api/promoter/events/import", { method: "POST", body: fd });
  // The route's JSON: a preview page, a commit result, or { error, header_errors }.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = (await res.json()) as any;
  return { ok: res.ok, body };
}

export default function ImportEventsPage() {
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [results, setResults] = useState<CommitResult[] | null>(null);

  const preview = async (f: File) => {
    setError(null);
    setResults(null);
    setRows([]);
    setNotes([]);
    setBusy("Checking your file…");
    try {
      const all: PreviewRow[] = [];
      let offset: number | null = 0;
      let commitPage = 25;
      while (offset !== null) {
        const { ok, body } = await post(f, { action: "preview", offset: String(offset) });
        if (!ok) {
          setError([body.error, ...(body.header_errors ?? [])].filter(Boolean).join(" "));
          return;
        }
        all.push(...body.rows);
        if (offset === 0 && body.unknown_columns?.length)
          setNotes([`These columns were ignored: ${body.unknown_columns.join(", ")}.`]);
        commitPage = body.commit_page ?? commitPage;
        offset = body.next_offset;
      }
      setRows(all);
      setSelected(
        new Set(all.filter((r) => r.status === "new" || r.status === "match").map((r) => r.row))
      );
    } catch {
      setError("Something went wrong reading the file. Please try again.");
    } finally {
      setBusy(null);
    }
  };

  const commit = async () => {
    if (!file || selected.size === 0) return;
    setError(null);
    const chosen = [...selected].sort((a, b) => a - b);
    const out: CommitResult[] = [];
    try {
      for (let i = 0; i < chosen.length; i += 25) {
        setBusy(`Importing rows ${i + 1}–${Math.min(i + 25, chosen.length)} of ${chosen.length}…`);
        const { ok, body } = await post(file, {
          action: "commit",
          rows: JSON.stringify(chosen.slice(i, i + 25)),
        });
        if (!ok) {
          setError(body.error ?? "Import failed.");
          break;
        }
        out.push(...body.results);
      }
    } finally {
      setResults(out);
      setBusy(null);
    }
  };

  const toggle = (row: number) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(row)) n.delete(row);
      else n.add(row);
      return n;
    });

  const counts = rows.reduce<Record<Status, number>>(
    (c, r) => ({ ...c, [r.status]: c[r.status] + 1 }),
    { new: 0, match: 0, already_imported: 0, error: 0 }
  );

  return (
    <div className="space-y-6 max-w-5xl">
      <Link
        href="/promoter/events"
        className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="w-4 h-4 mr-1" /> My Events
      </Link>
      <div>
        <h1 className="text-2xl font-bold">Import a season of shows</h1>
        <p className="text-muted-foreground mt-1">
          Send all your shows in one spreadsheet (CSV or Excel). You&apos;ll see every row before
          anything is saved. New shows go to our team for a quick review before they appear.
        </p>
      </div>

      <Card>
        <CardHeader>
          <h2 className="font-semibold">1. Get the template</h2>
        </CardHeader>
        <CardContent>
          <a
            href="/api/promoter/events/import/template"
            className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline"
          >
            <Download className="w-4 h-4" /> Download the template (CSV)
          </a>
          <p className="text-sm text-muted-foreground mt-2">
            Columns marked * are required: event name, start date, city and state. Dates like
            2027-10-02 or 10/2/2027; hours like 9am-4pm.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="font-semibold">2. Upload your file</h2>
        </CardHeader>
        <CardContent className="space-y-3">
          <label className="inline-flex items-center gap-2 cursor-pointer text-sm font-medium">
            <Upload className="w-4 h-4" />
            <input
              type="file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setFile(f);
                if (f) void preview(f);
              }}
            />
          </label>
          {busy && <p className="text-sm text-muted-foreground">{busy}</p>}
          {error && (
            <p role="alert" className="text-sm text-red-700">
              {error}
            </p>
          )}
          {notes.map((n) => (
            <p key={n} className="text-sm text-muted-foreground">
              {n}
            </p>
          ))}
        </CardContent>
      </Card>

      {rows.length > 0 && !results && (
        <Card>
          <CardHeader>
            <h2 className="font-semibold flex items-center gap-2">
              <FileSpreadsheet className="w-4 h-4" /> 3. Check the rows
            </h2>
            <p className="text-sm text-muted-foreground">
              {counts.new} new · {counts.match} match your existing events ·{" "}
              {counts.already_imported} already imported · {counts.error} need fixing. Changes to an
              event you already list are sent to us to review, not applied straight away.
            </p>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left border-b">
                    <th className="py-2 pr-2">Import</th>
                    <th className="py-2 pr-2">Row</th>
                    <th className="py-2 pr-2">Event</th>
                    <th className="py-2 pr-2">Start</th>
                    <th className="py-2 pr-2">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const selectable = r.status === "new" || r.status === "match";
                    return (
                      <tr key={r.row} className="border-b align-top">
                        <td className="py-2 pr-2">
                          <input
                            type="checkbox"
                            aria-label={`Import row ${r.row}`}
                            disabled={!selectable}
                            checked={selected.has(r.row)}
                            onChange={() => toggle(r.row)}
                          />
                        </td>
                        <td className="py-2 pr-2">{r.row}</td>
                        <td className="py-2 pr-2">{r.name ?? "—"}</td>
                        <td className="py-2 pr-2">{r.start_date ?? "—"}</td>
                        <td className="py-2 pr-2">
                          <span className="font-medium">{STATUS_LABEL[r.status]}</span>
                          {r.event && (
                            <span className="text-muted-foreground"> — {r.event.name}</span>
                          )}
                          {r.warnings?.map((w) => (
                            <div key={w} className="text-amber-700">
                              {w}
                            </div>
                          ))}
                          {r.errors.map((e) => (
                            <div key={e} className="text-red-700">
                              {e}
                            </div>
                          ))}
                          {r.changes && Object.keys(r.changes).length > 0 && (
                            <ul className="text-muted-foreground mt-1">
                              {Object.entries(r.changes).map(([f, c]) => (
                                <li key={f}>
                                  {f.replace(/_/g, " ")}: {c.current ?? "(blank)"} → {c.proposed}
                                </li>
                              ))}
                            </ul>
                          )}
                          {r.status === "match" &&
                            r.changes &&
                            Object.keys(r.changes).length === 0 && (
                              <div className="text-muted-foreground">No changes.</div>
                            )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mt-4">
              <Button
                type="button"
                disabled={!!busy || selected.size === 0}
                onClick={() => void commit()}
              >
                Import {selected.size} row{selected.size === 1 ? "" : "s"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {results && (
        <Card>
          <CardHeader>
            <h2 className="font-semibold">Done</h2>
          </CardHeader>
          <CardContent className="text-sm space-y-1">
            <p>
              {results.filter((r) => r.outcome === "created").length} new events sent for review ·{" "}
              {results.filter((r) => r.outcome === "update_staged").length} change requests sent ·{" "}
              {results.filter((r) => r.outcome === "skipped").length} skipped.
            </p>
            {results
              .filter((r) => r.outcome === "skipped")
              .map((r) => (
                <p key={r.row} className="text-muted-foreground">
                  Row {r.row}: {r.reason === "already_imported" ? "already imported" : r.reason}
                </p>
              ))}
            <Link href="/promoter/events" className="text-primary hover:underline">
              Back to My Events
            </Link>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
