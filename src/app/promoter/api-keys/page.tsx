"use client";

/**
 * OPE-1620 — the promoter's API keys for the signed events API.
 *
 * Create a key (the secret is shown ONCE, here, with a copy warning), list keys
 * (never their secrets), revoke. Docs: /help/promoters/api.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

interface KeyRow {
  key_id: string;
  name: string;
  created_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<{ key_id: string; secret: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/promoter/api-keys");
    const body = (await res.json()) as { keys?: KeyRow[]; error?: string };
    if (!res.ok) setError(body.error ?? "Could not load your keys.");
    else setKeys(body.keys ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setError(null);
    setBusy(true);
    setCopied(false);
    try {
      const res = await fetch("/api/promoter/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const body = (await res.json()) as { key_id?: string; secret?: string; error?: string };
      if (!res.ok || !body.key_id || !body.secret) {
        setError(body.error ?? "Could not create the key.");
        return;
      }
      setFresh({ key_id: body.key_id, secret: body.secret });
      setName("");
      await load();
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (keyId: string) => {
    if (!window.confirm(`Revoke ${keyId}? Anything using it will stop working at once.`)) return;
    setError(null);
    const res = await fetch(`/api/promoter/api-keys/${encodeURIComponent(keyId)}/revoke`, {
      method: "POST",
    });
    if (!res.ok) {
      const body = (await res.json()) as { error?: string };
      setError(body.error ?? "Could not revoke the key.");
    }
    if (fresh?.key_id === keyId) setFresh(null);
    await load();
  };

  const copy = async () => {
    if (!fresh) return;
    try {
      await navigator.clipboard.writeText(fresh.secret);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
          <KeyRound className="w-6 h-6" /> API keys
        </h1>
        <p className="text-muted-foreground mt-1">
          Send your events to Meet Me at the Fair from your own website, ticketing system, Zapier or
          Make. Every request is signed with a key&apos;s secret. New events are reviewed before
          they appear, and changes to a listed event are reviewed before they go live.{" "}
          <Link href="/help/promoters/api" className="underline">
            How to use the API
          </Link>
          .
        </p>
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-destructive p-3 text-destructive">
          {error}
        </div>
      )}

      {fresh && (
        <Card className="border-amber-500">
          <CardHeader>
            <h2 className="text-lg font-semibold">Copy your secret now</h2>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm">
              This is the only time we show this secret. Store it somewhere safe (a password manager
              or your system&apos;s secret settings). If you lose it, revoke this key and create a
              new one. Never put it in a web page or share it.
            </p>
            <dl className="grid grid-cols-[8rem_1fr] gap-2 text-sm">
              <dt className="font-medium">Key ID</dt>
              <dd>
                <code className="break-all">{fresh.key_id}</code>
              </dd>
              <dt className="font-medium">Secret</dt>
              <dd>
                <code className="break-all">{fresh.secret}</code>
              </dd>
            </dl>
            <div className="flex gap-2">
              <Button type="button" onClick={copy}>
                {copied ? "Copied" : "Copy secret"}
              </Button>
              <Button type="button" variant="outline" onClick={() => setFresh(null)}>
                I have saved it
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">Create a key</h2>
        </CardHeader>
        <CardContent>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <label htmlFor="key-name" className="sr-only">
              Key name
            </label>
            <input
              id="key-name"
              className="flex-1 rounded-md border border-border bg-background px-3 py-2"
              placeholder="What will use it, e.g. Website sync"
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy ? "Creating…" : "Create key"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">Your keys</h2>
        </CardHeader>
        <CardContent>
          {keys.length === 0 ? (
            <p className="text-muted-foreground text-sm">No keys yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-2">Name</th>
                  <th>Key ID</th>
                  <th>Created</th>
                  <th>Last used</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.key_id} className="border-t border-border">
                    <td className="py-2">{k.name}</td>
                    <td>
                      <code>{k.key_id}</code>
                    </td>
                    <td>{fmt(k.created_at)}</td>
                    <td>{fmt(k.last_used_at)}</td>
                    <td className="text-right">
                      {k.revoked_at ? (
                        <span className="text-muted-foreground">Revoked {fmt(k.revoked_at)}</span>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => void revoke(k.key_id)}
                        >
                          Revoke
                        </Button>
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
