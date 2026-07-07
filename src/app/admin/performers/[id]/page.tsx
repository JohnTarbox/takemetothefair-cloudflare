"use client";

/**
 * OPE-113 PR#2 — performer admin/detail: edit fields, verify, alias, merge, and
 * the cross-event appearance history. Admin-only route.
 */
import { useState, useEffect, use, useCallback } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Performer {
  id: string;
  name: string;
  slug: string;
  performerType: string | null;
  actCategory: string | null;
  website: string | null;
  homeBaseCity: string | null;
  homeBaseState: string | null;
  verified: boolean;
  deletedAt: number | null;
}
interface Appearance {
  id: string;
  event_id: string;
  event_name: string;
  event_slug: string;
  billing: string | null;
  status: string;
}
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

export default function PerformerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [p, setP] = useState<Performer | null>(null);
  const [appearances, setAppearances] = useState<Appearance[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [otherId, setOtherId] = useState("");

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/performers/${id}`);
    if (!res.ok) return;
    const data = (await res.json()) as { performer: Performer; appearances: Appearance[] };
    setP(data.performer);
    setAppearances(data.appearances);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(body: Record<string, unknown>) {
    setMsg(null);
    const res = await fetch(`/api/admin/performers/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setMsg(res.ok ? "Saved." : "Save failed.");
    await load();
  }

  async function action(body: Record<string, unknown>) {
    setMsg(null);
    const res = await fetch(`/api/admin/performers/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { error?: string; moved?: number; dropped?: number };
    setMsg(
      res.ok
        ? `Done${data.moved !== undefined ? ` (moved ${data.moved}, dropped ${data.dropped})` : ""}.`
        : `Failed: ${data.error}`
    );
    await load();
  }

  if (!p) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <Link
        href="/admin/performers"
        className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="w-4 h-4 mr-1" /> All performers
      </Link>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {p.name}
            {p.verified && <Badge>verified</Badge>}
            {p.deletedAt && <Badge variant="danger">deleted</Badge>}
          </CardTitle>
          <code className="text-xs text-muted-foreground">/performers/{p.slug}</code>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <Label>Name</Label>
              <Input
                defaultValue={p.name}
                onBlur={(e) => e.target.value !== p.name && void save({ name: e.target.value })}
              />
            </div>
            <div>
              <Label>Website</Label>
              <Input
                defaultValue={p.website ?? ""}
                onBlur={(e) => void save({ website: e.target.value })}
              />
            </div>
            <div>
              <Label>Type</Label>
              <select
                className="w-full border rounded h-9 px-2 text-sm"
                value={p.performerType ?? ""}
                onChange={(e) => void save({ performer_type: e.target.value })}
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
                value={p.actCategory ?? ""}
                onChange={(e) => void save({ act_category: e.target.value })}
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
              <Label>Home base city</Label>
              <Input
                defaultValue={p.homeBaseCity ?? ""}
                onBlur={(e) => void save({ home_base_city: e.target.value })}
              />
            </div>
            <div>
              <Label>Home base state</Label>
              <Input
                defaultValue={p.homeBaseState ?? ""}
                onBlur={(e) => void save({ home_base_state: e.target.value })}
              />
            </div>
          </div>
          <Button
            variant={p.verified ? "secondary" : "primary"}
            onClick={() => void save({ verified: !p.verified })}
          >
            {p.verified ? "Un-verify" : "Verify"}
          </Button>
          {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Alias / Merge</CardTitle>
          <p className="text-xs text-muted-foreground">
            Alias: mark THIS performer as a duplicate of another (canonical) id. Merge: fold another
            (duplicate) id INTO this one, moving its appearances.
          </p>
        </CardHeader>
        <CardContent className="space-y-2">
          <Input
            value={otherId}
            onChange={(e) => setOtherId(e.target.value)}
            placeholder="Other performer id"
          />
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={!otherId}
              onClick={() => void action({ action: "alias", canonical_performer_id: otherId })}
            >
              This IS an alias of that
            </Button>
            <Button
              variant="outline"
              disabled={!otherId}
              onClick={() => void action({ action: "merge", duplicate_performer_id: otherId })}
            >
              Merge that INTO this
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Appearances ({appearances.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {appearances.length === 0 ? (
            <p className="text-sm text-muted-foreground">None.</p>
          ) : (
            <div className="space-y-1">
              {appearances.map((a) => (
                <div key={a.id} className="flex items-center gap-2 text-sm border rounded p-2">
                  <Badge variant={a.status === "CONFIRMED" ? "success" : "warning"}>
                    {a.status}
                  </Badge>
                  <Link href={`/admin/events/${a.event_id}/performers`} className="hover:underline">
                    {a.event_name}
                  </Link>
                  {a.billing && (
                    <span className="ml-auto text-xs text-muted-foreground">{a.billing}</span>
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
