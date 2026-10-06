"use client";

/**
 * OPE-1330 — the "Contacts" section on the admin promoter page: the named
 * people at this promoter who have actually corresponded with us, how each was
 * validated, and a status change (with a required reason, audit-logged).
 *
 * ⚠️ Personal contact data. This component only ever renders inside /admin and
 * reads /api/admin/* (role-gated). Never import it into a public page.
 */
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Status = "candidate" | "validated" | "stale" | "rejected";
interface Contact {
  id: string;
  name: string | null;
  role: string | null;
  email: string;
  phone: string | null;
  validationMethod: string;
  validationEvidence: string | null;
  inboundEmailId: string | null;
  senderAuth: string | null;
  authDomain: string | null;
  authDomainMatchesPromoter: boolean | null;
  status: Status;
  firstValidatedAt: string | null;
  lastHeardAt: string | null;
}

const STATUSES: Status[] = ["candidate", "validated", "stale", "rejected"];
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "—");

function ContactRow({ c, onChanged }: { c: Contact; onChanged: () => void }) {
  const [next, setNext] = useState<Status>(c.status);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/promoter-contacts/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next, reason }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: unknown };
        setError(typeof body.error === "string" ? body.error : "Could not change the status.");
        return;
      }
      setReason("");
      onChanged();
    } finally {
      setSaving(false);
    }
  };

  return (
    <li className="border border-border rounded p-3 space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-medium text-foreground">{c.name ?? "(no name)"}</span>
        {c.role && <span className="text-sm text-muted-foreground">{c.role}</span>}
        <span className="text-sm">{c.email}</span>
        {c.phone && <span className="text-sm">{c.phone}</span>}
        <span className="text-xs rounded bg-muted px-2 py-0.5">{c.status}</span>
      </div>
      <div className="text-xs text-muted-foreground space-y-0.5">
        <div>
          Validated by <strong>{c.validationMethod}</strong> · first validated{" "}
          {day(c.firstValidatedAt)} · last heard {day(c.lastHeardAt)}
        </div>
        <div>
          Mail auth: {c.senderAuth ?? "—"} · authenticated domain {c.authDomain ?? "—"} ·
          promoter&apos;s own domain:{" "}
          {c.authDomainMatchesPromoter === null
            ? "unknown"
            : c.authDomainMatchesPromoter
              ? "yes"
              : "no"}
        </div>
        {c.validationEvidence && (
          <div className="break-words">Evidence: {c.validationEvidence}</div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label={`Status for ${c.email}`}
          className="h-8 rounded border border-border bg-background px-2 text-sm"
          value={next}
          onChange={(e) => setNext(e.target.value as Status)}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input
          aria-label="Reason for the change"
          className="h-8 flex-1 min-w-[12rem] rounded border border-border bg-background px-2 text-sm"
          placeholder="Reason (required)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <Button
          type="button"
          size="sm"
          disabled={saving || next === c.status || reason.trim().length === 0}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void save();
          }}
        >
          {saving ? "Saving..." : "Change status"}
        </Button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </li>
  );
}

export function PromoterContactsSection({ promoterId }: { promoterId: string }) {
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/promoters/${promoterId}/contacts`);
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { contacts: Contact[] };
      setContacts(body.contacts);
      setError(null);
    } catch {
      setError("Could not load contacts.");
    }
  }, [promoterId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>Contacts</CardTitle>
        <p className="text-sm text-muted-foreground">
          People at this promoter who have actually written to us. Admin only — never shown
          publicly. &ldquo;validated&rdquo; by domain_verified proves the mail came from the
          promoter&apos;s domain, not the person&apos;s name or role.
        </p>
      </CardHeader>
      <CardContent>
        {error && <p className="text-sm text-red-600">{error}</p>}
        {!error && contacts === null && <p className="text-sm text-muted-foreground">Loading…</p>}
        {contacts !== null && contacts.length === 0 && (
          <p className="text-sm text-muted-foreground">No contacts recorded yet.</p>
        )}
        {contacts !== null && contacts.length > 0 && (
          <ul className="space-y-3">
            {contacts.map((c) => (
              <ContactRow key={c.id} c={c} onChanged={() => void load()} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
