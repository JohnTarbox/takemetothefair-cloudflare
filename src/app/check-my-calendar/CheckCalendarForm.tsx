"use client";

/**
 * OPE-1625 — the "Check my calendar" form: POSTs the pasted address to
 * /api/v1/check-calendar and renders the report. Saves nothing.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CalendarCheckReport, ItemReport } from "@/lib/test-submission/types";

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "done"; report: CalendarCheckReport };

const KIND_LABEL: Record<CalendarCheckReport["source"]["kind"], string> = {
  ical: "an iCal calendar",
  tec_rest: "The Events Calendar (WordPress) feed",
  jsonld: "event information on a web page",
};

function Item({ item }: { item: ItemReport }) {
  const o = item.outcome;
  const read = item.read.filter((r) => r.value !== null);
  return (
    <li className="rounded-md border border-border p-4 space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">{item.title || "(no title)"}</h3>
        <span className="text-sm font-medium">
          {o.kind === "new"
            ? "Would pick up"
            : o.kind === "match"
              ? "Already listed"
              : "Would skip"}
        </span>
      </div>
      <p className="text-sm">{o.summary}</p>
      {o.kind === "match" && o.listing.url && (
        <p className="text-sm">
          Listing:{" "}
          <a href={o.listing.url} className="underline" target="_blank" rel="noreferrer">
            {o.listing.name ?? o.listing.url}
          </a>
        </p>
      )}
      {o.kind === "match" && o.changes.length > 0 && (
        <ul className="text-sm list-disc pl-5">
          {o.changes.map((c) => (
            <li key={c.field}>
              {c.field}: {c.current ?? "(blank)"} → {c.proposed ?? "(blank)"}
            </li>
          ))}
        </ul>
      )}
      {item.problems.length > 0 && (
        <ul className="text-sm list-disc pl-5">
          {item.problems.map((p) => (
            <li key={`${p.code}-${p.field ?? ""}`}>
              <span className="font-medium">{p.severity === "error" ? "Problem" : "Check"}:</span>{" "}
              {p.message}
            </li>
          ))}
        </ul>
      )}
      {read.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer">What we read</summary>
          <dl className="mt-2 grid grid-cols-1 sm:grid-cols-[10rem_1fr] gap-x-4 gap-y-1">
            {read.map((r) => (
              <div key={r.field} className="contents">
                <dt className="text-muted-foreground">{r.label}</dt>
                <dd className="break-words">
                  {r.value} <span className="text-muted-foreground">({r.source})</span>
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </li>
  );
}

export function CheckCalendarForm() {
  const [url, setUrl] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setState({ kind: "loading" });
    try {
      const res = await fetch("/api/v1/check-calendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const body = (await res.json()) as CalendarCheckReport & { error?: { message: string } };
      if (!res.ok || body.error)
        setState({ kind: "error", message: body.error?.message ?? "We could not check that." });
      else setState({ kind: "done", report: body });
    } catch {
      setState({ kind: "error", message: "We could not reach the checker. Try again." });
    }
  }

  const report = state.kind === "done" ? state.report : null;
  const picked = report ? report.items.filter((i) => i.outcome.kind !== "skip") : [];
  const skipped = report ? report.items.filter((i) => i.outcome.kind === "skip") : [];

  return (
    <div className="space-y-6">
      <form onSubmit={onSubmit} className="space-y-3">
        <Label htmlFor="calendar-url">Calendar address</Label>
        <Input
          id="calendar-url"
          type="url"
          inputMode="url"
          required
          placeholder="https://example.org/events/?ical=1"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <Button type="submit" disabled={state.kind === "loading"}>
          {state.kind === "loading" ? "Checking…" : "Check"}
        </Button>
      </form>

      <div aria-live="polite">
        {state.kind === "error" && <p className="text-red-700">{state.message}</p>}
        {report && (
          <div className="space-y-6">
            <p>
              We read {KIND_LABEL[report.source.kind]}
              {report.source.calendar_name ? ` (“${report.source.calendar_name}”)` : ""}:{" "}
              {report.counts.read} event{report.counts.read === 1 ? "" : "s"} between{" "}
              {report.window.start} and {report.window.end}. We would pick up{" "}
              {report.counts.would_pick_up} and skip {report.counts.skipped}.
              {report.counts.with_problems > 0
                ? ` ${report.counts.with_problems} have something to check.`
                : ""}
            </p>
            {report.notes.length > 0 && (
              <ul className="text-sm list-disc pl-5 text-muted-foreground">
                {report.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
            {picked.length > 0 && (
              <section className="space-y-3">
                <h2 className="text-xl font-semibold">Events we would pick up</h2>
                <ul className="space-y-3">
                  {picked.map((i, n) => (
                    <Item key={`${i.external_id ?? ""}-${n}`} item={i} />
                  ))}
                </ul>
              </section>
            )}
            {skipped.length > 0 && (
              <section className="space-y-3">
                <h2 className="text-xl font-semibold">Events we would skip</h2>
                <ul className="space-y-3">
                  {skipped.map((i, n) => (
                    <Item key={`${i.external_id ?? ""}-${n}`} item={i} />
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
