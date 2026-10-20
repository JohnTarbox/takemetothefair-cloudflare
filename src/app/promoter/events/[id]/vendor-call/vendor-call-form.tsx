"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import type { VendorCallState } from "@/lib/promoter/vendor-call";

const CAPACITY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "UNKNOWN", label: "Not saying" },
  { value: "OPEN", label: "Open — taking applications" },
  { value: "WAITLIST", label: "Full — taking a waitlist" },
  { value: "FULL", label: "Full" },
  { value: "CLOSED", label: "Not taking applications" },
];

/** "Pottery, Woodworking" ⇄ ["Pottery", "Woodworking"]. The server normalizes. */
const toList = (s: string) =>
  s
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
const fromList = (l: string[]) => l.join(", ");
const money = (n: number | null) => (n == null ? "" : String(n));

export function VendorCallForm({ initial }: { initial: VendorCallState }) {
  const [state, setState] = useState(initial);
  const [form, setForm] = useState(() => formFrom(initial));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  function formFrom(s: VendorCallState) {
    return {
      applicationDeadline: s.applicationDeadline ?? "",
      applicationUrl: s.applicationUrl ?? "",
      vendorFeeMin: money(s.vendorFeeMin),
      vendorFeeMax: money(s.vendorFeeMax),
      vendorFeeNotes: s.vendorFeeNotes ?? "",
      capacityStatus: s.capacityStatus,
      capacityNote: s.capacityNote ?? "",
      categoriesWanted: fromList(s.categoriesWanted),
      categoriesFull: fromList(s.categoriesFull),
    };
  }

  const set =
    (key: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  /** Send ONLY what changed, so an untouched field is never rewritten. */
  function changes(): Record<string, unknown> {
    const before = formFrom(state);
    const body: Record<string, unknown> = {};
    const str = (v: string) => v.trim() || null;
    const num = (v: string) => (v.trim() === "" ? null : Number(v));
    if (form.applicationDeadline !== before.applicationDeadline)
      body.applicationDeadline = str(form.applicationDeadline);
    if (form.applicationUrl !== before.applicationUrl)
      body.applicationUrl = str(form.applicationUrl);
    if (form.vendorFeeMin !== before.vendorFeeMin) body.vendorFeeMin = num(form.vendorFeeMin);
    if (form.vendorFeeMax !== before.vendorFeeMax) body.vendorFeeMax = num(form.vendorFeeMax);
    if (form.vendorFeeNotes !== before.vendorFeeNotes)
      body.vendorFeeNotes = str(form.vendorFeeNotes);
    if (form.capacityStatus !== before.capacityStatus) body.capacityStatus = form.capacityStatus;
    if (form.capacityNote !== before.capacityNote) body.capacityNote = str(form.capacityNote);
    if (form.categoriesWanted !== before.categoriesWanted)
      body.categoriesWanted = toList(form.categoriesWanted);
    if (form.categoriesFull !== before.categoriesFull)
      body.categoriesFull = toList(form.categoriesFull);
    return body;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const body = changes();
    if (Object.keys(body).length === 0) {
      setMessage({ kind: "ok", text: "Nothing changed." });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/promoter/events/${state.event.id}/vendor-call`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as VendorCallState & { error?: string };
      if (!res.ok) {
        setMessage({ kind: "error", text: data.error ?? "Could not save." });
        return;
      }
      setState(data as VendorCallState);
      setForm(formFrom(data as VendorCallState));
      setMessage({ kind: "ok", text: "Saved." });
    } catch {
      setMessage({ kind: "error", text: "Could not save. Check your connection and try again." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardContent className="pt-6">
        <form onSubmit={onSubmit} className="space-y-5">
          <div>
            <label
              htmlFor="capacityStatus"
              className="block text-sm font-medium text-foreground mb-1"
            >
              Are you taking vendor applications?
            </label>
            <select
              id="capacityStatus"
              value={form.capacityStatus}
              onChange={set("capacityStatus")}
              className="w-full h-10 rounded-md border border-border bg-card px-3 py-2 text-sm"
            >
              {CAPACITY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {state.capacityAsOf && (
              <p className="mt-1 text-xs text-muted-foreground">
                Last updated {state.capacityAsOf}
              </p>
            )}
          </div>
          <Input
            label="Capacity details (optional)"
            name="capacityNote"
            value={form.capacityNote}
            onChange={set("capacityNote")}
            placeholder='e.g., "Craft hall full; outdoor spaces still available"'
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input
              label="Applications close"
              type="date"
              name="applicationDeadline"
              value={form.applicationDeadline}
              onChange={set("applicationDeadline")}
            />
            <Input
              label="Application link"
              name="applicationUrl"
              value={form.applicationUrl}
              onChange={set("applicationUrl")}
              placeholder="https://… or mailto:…"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Min booth fee ($)"
              type="number"
              min="0"
              step="0.01"
              name="vendorFeeMin"
              value={form.vendorFeeMin}
              onChange={set("vendorFeeMin")}
            />
            <Input
              label="Max booth fee ($)"
              type="number"
              min="0"
              step="0.01"
              name="vendorFeeMax"
              value={form.vendorFeeMax}
              onChange={set("vendorFeeMax")}
            />
          </div>
          <Input
            label="Fee details"
            name="vendorFeeNotes"
            value={form.vendorFeeNotes}
            onChange={set("vendorFeeNotes")}
            placeholder='e.g., "$50 for 10x10, $75 for 10x20"'
          />
          <div>
            <label
              htmlFor="categoriesWanted"
              className="block text-sm font-medium text-foreground mb-1"
            >
              Vendors you&apos;re looking for
            </label>
            <textarea
              id="categoriesWanted"
              value={form.categoriesWanted}
              onChange={set("categoriesWanted")}
              rows={2}
              placeholder="Pottery, Woodworking, Baked goods"
              className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label
              htmlFor="categoriesFull"
              className="block text-sm font-medium text-foreground mb-1"
            >
              Categories that are full
            </label>
            <textarea
              id="categoriesFull"
              value={form.categoriesFull}
              onChange={set("categoriesFull")}
              rows={2}
              placeholder="Jewelry, Candles"
              className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Separate with commas.
              {state.categoriesAsOf && ` Last updated ${state.categoriesAsOf}.`}
            </p>
          </div>
          {message && (
            <p
              role="status"
              className={
                message.kind === "error" ? "text-sm text-destructive" : "text-sm text-foreground"
              }
            >
              {message.text}
            </p>
          )}
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save vendor call"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
