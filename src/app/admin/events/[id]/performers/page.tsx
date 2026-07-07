"use client";

/**
 * OPE-113 PR#2 — event-edit "Performers / Entertainment" section. Add an act
 * (fuzzy-dedup → confirm), assign day/time/stage + billing, toggle status. The
 * public event page only shows CONFIRMED acts (Phase 2). Admin-only route.
 */
import { useState, useEffect, use, useCallback } from "react";
import Link from "next/link";
import { ArrowLeft, Plus, Trash2, Music } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Appearance {
  id: string;
  performer_id: string;
  performer_name?: string;
  performer_slug?: string;
  event_day_id: string | null;
  performance_start: number | null;
  stage: string | null;
  billing: string | null;
  status: string;
  source_url: string | null;
}
interface Match {
  id: string;
  name: string;
  slug: string;
  score: number;
}

const BILLING = ["HEADLINER", "FEATURED", "SUPPORTING"];
const STATUSES = ["CONFIRMED", "PENDING", "CANCELLED"];
const ACT_CATEGORIES = [
  "MUSIC",
  "ANIMAL_SHOW",
  "MAGIC",
  "COMEDY",
  "CIRCUS",
  "DANCE",
  "THEATER",
  "EDUCATIONAL",
  "CHILDRENS",
  "DEMONSTRATION",
  "OTHER",
];
const statusVariant = (s: string): "success" | "danger" | "warning" =>
  s === "CONFIRMED" ? "success" : s === "CANCELLED" ? "danger" : "warning";

export default function EventPerformersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [rows, setRows] = useState<Appearance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [matches, setMatches] = useState<Match[] | null>(null);

  // Add-form state
  const [name, setName] = useState("");
  const [performerType, setPerformerType] = useState("");
  const [actCategory, setActCategory] = useState("");
  const [billing, setBilling] = useState("");
  const [status, setStatus] = useState("PENDING");
  const [stage, setStage] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/events/${id}/performers`);
      const data = (await res.json()) as { appearances?: Appearance[] };
      setRows(data.appearances ?? []);
    } catch {
      setError("Failed to load performers.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function add(opts: { performer_id?: string; confirm_create_new?: boolean } = {}) {
    if (!sourceUrl.trim()) {
      setError("Source URL is required (provenance).");
      return;
    }
    if (!opts.performer_id && !name.trim()) {
      setError("Enter an act name.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/events/${id}/performers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || undefined,
          performer_id: opts.performer_id,
          confirm_create_new: opts.confirm_create_new,
          performer_type: performerType || undefined,
          act_category: actCategory || undefined,
          billing: billing || undefined,
          status,
          stage: stage.trim() || undefined,
          source_url: sourceUrl.trim(),
        }),
      });
      if (res.status === 409) {
        const data = (await res.json()) as { matches: Match[] };
        setMatches(data.matches);
        return;
      }
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setError(data.error ?? "Add failed.");
        return;
      }
      setName("");
      setStage("");
      setBilling("");
      setActCategory("");
      setPerformerType("");
      setMatches(null);
      await load();
    } finally {
      setSubmitting(false);
    }
  }

  async function patch(apprId: string, body: Record<string, unknown>) {
    await fetch(`/api/admin/events/${id}/performers`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event_performer_id: apprId, ...body }),
    });
    await load();
  }
  async function remove(apprId: string) {
    await fetch(`/api/admin/events/${id}/performers?event_performer_id=${apprId}`, {
      method: "DELETE",
    });
    await load();
  }

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <Link
        href={`/admin/events/${id}/edit`}
        className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="w-4 h-4 mr-1" /> Back to event
      </Link>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Music className="w-5 h-5" /> Performers / Entertainment
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Only CONFIRMED acts appear on the public event page + structured data. Every add records
            a source URL (provenance).
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <Label>Act name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Mr. Drew and His Animals Too"
              />
            </div>
            <div>
              <Label>Source URL (provenance)</Label>
              <Input
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
                placeholder="https://…"
              />
            </div>
            <div>
              <Label>Type</Label>
              <select
                className="w-full border rounded h-9 px-2 text-sm"
                value={performerType}
                onChange={(e) => setPerformerType(e.target.value)}
              >
                <option value="">—</option>
                <option value="PERSON">PERSON</option>
                <option value="GROUP">GROUP</option>
              </select>
            </div>
            <div>
              <Label>Category</Label>
              <select
                className="w-full border rounded h-9 px-2 text-sm"
                value={actCategory}
                onChange={(e) => setActCategory(e.target.value)}
              >
                <option value="">—</option>
                {ACT_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>Billing</Label>
              <select
                className="w-full border rounded h-9 px-2 text-sm"
                value={billing}
                onChange={(e) => setBilling(e.target.value)}
              >
                <option value="">—</option>
                {BILLING.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>Status</Label>
              <select
                className="w-full border rounded h-9 px-2 text-sm"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="md:col-span-2">
              <Label>Stage</Label>
              <Input
                value={stage}
                onChange={(e) => setStage(e.target.value)}
                placeholder="Main Stage"
              />
            </div>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          {matches && (
            <div className="border rounded p-3 bg-amber-50 text-sm space-y-2">
              <p className="font-medium">Possible duplicate act(s) — link one, or create new:</p>
              {matches.map((m) => (
                <div key={m.id} className="flex items-center justify-between">
                  <span>
                    {m.name} <span className="text-muted-foreground">({m.score})</span>
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={submitting}
                    onClick={() => void add({ performer_id: m.id })}
                  >
                    Link this act
                  </Button>
                </div>
              ))}
              <Button
                size="sm"
                variant="secondary"
                disabled={submitting}
                onClick={() => void add({ confirm_create_new: true })}
              >
                None of these — create new
              </Button>
            </div>
          )}

          <Button disabled={submitting} onClick={() => void add()}>
            <Plus className="w-4 h-4 mr-1" /> Add act
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Lineup ({rows.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No acts yet.</p>
          ) : (
            <div className="space-y-2">
              {rows.map((r) => (
                <div key={r.id} className="flex flex-wrap items-center gap-2 border rounded p-2">
                  <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
                  <Link
                    href={`/admin/performers/${r.performer_id}`}
                    className="font-medium hover:underline"
                  >
                    {r.performer_name}
                  </Link>
                  {r.stage && <span className="text-xs text-muted-foreground">@ {r.stage}</span>}
                  <div className="ml-auto flex items-center gap-2">
                    <select
                      className="border rounded h-8 px-1 text-xs"
                      value={r.billing ?? ""}
                      onChange={(e) => void patch(r.id, { billing: e.target.value || null })}
                    >
                      <option value="">billing…</option>
                      {BILLING.map((b) => (
                        <option key={b} value={b}>
                          {b}
                        </option>
                      ))}
                    </select>
                    <select
                      className="border rounded h-8 px-1 text-xs"
                      value={r.status}
                      onChange={(e) => void patch(r.id, { status: e.target.value })}
                    >
                      {STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                    <Button size="sm" variant="ghost" onClick={() => void remove(r.id)}>
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
