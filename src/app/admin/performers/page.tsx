"use client";

/**
 * OPE-113 PR#2 — admin performers list: search + create. Admin-only route.
 */
import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Music, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Row {
  id: string;
  name: string;
  slug: string;
  verified: boolean;
}

export default function PerformersListPage() {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/performers?q=${encodeURIComponent(q)}`);
    const data = (await res.json()) as { performers?: Row[] };
    setRows(data.performers ?? []);
  }, [q]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch(`/api/admin/performers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim() }),
      });
      const data = (await res.json()) as { performer?: { id: string } };
      setNewName("");
      if (data.performer) window.location.href = `/admin/performers/${data.performer.id}`;
      else await load();
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Music className="w-5 h-5" /> Performers
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Label>Search</Label>
              <div className="relative">
                <Search className="w-4 h-4 absolute left-2 top-2.5 text-muted-foreground" />
                <Input
                  className="pl-8"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Act name…"
                />
              </div>
            </div>
            <div className="flex-1">
              <Label>Create new</Label>
              <div className="flex gap-2">
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="New act name"
                />
                <Button disabled={creating} onClick={() => void create()}>
                  <Plus className="w-4 h-4" />
                </Button>
              </div>
            </div>
          </div>

          <div className="space-y-1">
            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">No performers.</p>
            ) : (
              rows.map((r) => (
                <Link
                  key={r.id}
                  href={`/admin/performers/${r.id}`}
                  className="flex items-center gap-2 border rounded p-2 hover:bg-muted"
                >
                  <span className="font-medium">{r.name}</span>
                  <code className="text-xs text-muted-foreground">{r.slug}</code>
                  {r.verified && <Badge className="ml-auto">verified</Badge>}
                </Link>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
