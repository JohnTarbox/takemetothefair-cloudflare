"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Search, X, Check, Loader2 } from "lucide-react";

/**
 * OPE-239 — "Which of our fairs have you sold at?"
 *
 * A searchable multi-select over our APPROVED events. Deliberately searches
 * PAST events too — historical appearances are the whole point, since the
 * events we most lack rosters for already happened.
 *
 * Saves the WHOLE set (PUT), not per-item add/remove: the component holds the
 * authoritative selection, so a set-replace can't drift from what the vendor
 * sees. Idempotent server-side.
 */

interface EventResult {
  id: string;
  name: string;
  slug: string;
  startDate: string | null;
  city: string | null;
  state: string | null;
}

interface SelectedItem {
  eventId: string;
  eventName: string;
  startDate: string | null;
  city: string | null;
  state: string | null;
}

function yearOf(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : String(d.getUTCFullYear());
}

function placeOf(city: string | null, state: string | null): string {
  return city && state ? `${city}, ${state}` : "";
}

function subtitle(startDate: string | null, city: string | null, state: string | null): string {
  return [yearOf(startDate), placeOf(city, state)].filter(Boolean).join(" · ");
}

export function SelfReportedFairsEditor() {
  const [selected, setSelected] = useState<SelectedItem[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<EventResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<null | { kind: "ok" | "err"; text: string }>(null);
  const [loaded, setLoaded] = useState(false);

  // Guards an out-of-order search response from overwriting a newer one — the
  // classic autocomplete bug where a slow early query lands last and the list
  // flips back to stale results.
  const searchSeq = useRef(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/vendor/self-reported-events");
        if (!res.ok) return;
        const data = (await res.json()) as { selected: SelectedItem[] };
        if (!cancelled) setSelected(data.selected ?? []);
      } catch {
        // Non-fatal: the editor still works, it just starts empty. Saving would
        // then wipe the set, so we only enable Save once we've loaded.
        return;
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    const seq = ++searchSeq.current;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/vendor/self-reported-events?q=${encodeURIComponent(q)}`);
        const data = (await res.json()) as { results?: EventResult[] };
        if (seq === searchSeq.current) setResults(data.results ?? []);
      } catch {
        if (seq === searchSeq.current) setResults([]);
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  const add = useCallback((e: EventResult) => {
    setSelected((prev) =>
      prev.some((p) => p.eventId === e.id)
        ? prev
        : [
            ...prev,
            {
              eventId: e.id,
              eventName: e.name,
              startDate: e.startDate,
              city: e.city,
              state: e.state,
            },
          ]
    );
    setQuery("");
    setResults([]);
    setStatus(null);
  }, []);

  const remove = useCallback((eventId: string) => {
    setSelected((prev) => prev.filter((p) => p.eventId !== eventId));
    setStatus(null);
  }, []);

  async function save() {
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch("/api/vendor/self-reported-events", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_ids: selected.map((s) => s.eventId) }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        message?: string;
        error?: string;
      };
      if (!res.ok) {
        setStatus({
          kind: "err",
          text: data.message ?? data.error ?? "Could not save — please try again.",
        });
        return;
      }
      setStatus({ kind: "ok", text: "Saved." });
    } catch {
      setStatus({ kind: "err", text: "Could not save — please try again." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-base font-semibold text-foreground">
          Which of our fairs have you sold at?
        </h3>
        <p className="text-sm text-muted-foreground mt-1">
          Add the events you&apos;ve exhibited at — past ones count, and they help most. These
          appear on your public profile clearly marked as{" "}
          <strong className="font-medium">vendor-stated</strong>, not confirmed by the organizer.
        </p>
      </div>

      <div className="relative">
        <Search
          className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground"
          aria-hidden
        />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search fairs by name or town…"
          aria-label="Search fairs you have sold at"
          className="w-full pl-9 pr-3 py-2 rounded-md border border-border bg-background text-foreground text-sm focus:border-royal focus:outline-none"
        />
        {searching && (
          <Loader2
            className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-muted-foreground"
            aria-hidden
          />
        )}
      </div>

      {results.length > 0 && (
        <ul className="border border-border rounded-md divide-y divide-border max-h-64 overflow-y-auto">
          {results.map((r) => {
            const already = selected.some((s) => s.eventId === r.id);
            return (
              <li key={r.id}>
                <button
                  type="button"
                  disabled={already}
                  onClick={(e) => {
                    e.preventDefault();
                    add(r);
                  }}
                  className="w-full text-left px-3 py-2 hover:bg-muted disabled:opacity-50 disabled:hover:bg-transparent flex items-center justify-between gap-2"
                >
                  <span>
                    <span className="block text-sm text-foreground">{r.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {subtitle(r.startDate, r.city, r.state)}
                    </span>
                  </span>
                  {already && <Check className="w-4 h-4 text-sage-700 shrink-0" aria-hidden />}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {query.trim().length >= 2 && !searching && results.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No matching fairs. Try the town name, or a shorter search.
        </p>
      )}

      {selected.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {selected.map((s) => (
            <li
              key={s.eventId}
              className="inline-flex items-center gap-1.5 pl-3 pr-1.5 py-1 rounded-full bg-muted text-sm text-foreground"
            >
              <span>
                {s.eventName}
                {yearOf(s.startDate) && (
                  <span className="text-muted-foreground"> {yearOf(s.startDate)}</span>
                )}
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  remove(s.eventId);
                }}
                aria-label={`Remove ${s.eventName}`}
                className="p-0.5 rounded-full hover:bg-border"
              >
                <X className="w-3.5 h-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            void save();
          }}
          // Disabled until the initial load resolves: saving from an unloaded
          // state would PUT an empty set and silently wipe existing entries.
          disabled={!loaded || saving}
          className="px-4 py-2 rounded-md bg-royal text-white font-medium text-sm hover:bg-navy disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save fairs"}
        </button>
        {status && (
          <span
            role="status"
            className={
              status.kind === "ok" ? "text-sm text-sage-700" : "text-sm text-danger-soft-foreground"
            }
          >
            {status.text}
          </span>
        )}
      </div>
    </div>
  );
}
