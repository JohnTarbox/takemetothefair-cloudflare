/**
 * OPE-1178 — the idea log: product features and improvements worth
 * remembering, kept apart from every defect ledger (see `productIdeas` in
 * packages/db-schema). Admin only, no public surface.
 *
 * Same shape as /admin/problem-reports: a server-rendered list, filter chips as
 * links, and a plain form per row for the status change — no client JS. Ideas
 * are added and edited through the `add_idea` / `update_idea` MCP tools.
 */

import Link from "next/link";
import { redirect } from "next/navigation";
import { and, desc, eq, sql } from "drizzle-orm";
import { getCloudflareDb } from "@/lib/cloudflare";
import { productIdeas } from "@/lib/db/schema";
import { IDEA_PRODUCTS, IDEA_STATUSES } from "@takemetothefair/db-schema";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { auth } from "@/lib/auth";

export const dynamic = "force-dynamic";

type Status = (typeof IDEA_STATUSES)[number];
type Product = (typeof IDEA_PRODUCTS)[number];

interface SearchParams {
  status?: string;
  product?: string;
}

function parseRefs(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export default async function AdminIdeasPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await auth();
  if (session?.user?.role !== "ADMIN") redirect("/");

  const sp = await searchParams;
  const status = (IDEA_STATUSES as readonly string[]).includes(sp.status ?? "")
    ? (sp.status as Status)
    : null;
  const product = (IDEA_PRODUCTS as readonly string[]).includes(sp.product ?? "")
    ? (sp.product as Product)
    : null;

  const db = getCloudflareDb();
  const conditions = [];
  if (status) conditions.push(eq(productIdeas.status, status));
  if (product) conditions.push(eq(productIdeas.product, product));

  const [rows, counts] = await Promise.all([
    db
      .select()
      .from(productIdeas)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(productIdeas.votes), desc(productIdeas.createdAt))
      .limit(200),
    db
      .select({ status: productIdeas.status, n: sql<number>`count(*)` })
      .from(productIdeas)
      .groupBy(productIdeas.status),
  ]);
  const countOf = (s: string) => Number(counts.find((c) => c.status === s)?.n ?? 0);
  const total = counts.reduce((a, c) => a + Number(c.n), 0);

  const back = `/admin/ideas${sp.status || sp.product ? `?${new URLSearchParams(sp as Record<string, string>).toString()}` : ""}`;

  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-2xl font-bold text-navy mb-2">Ideas</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Features and improvements worth remembering, not yet decided. Kept apart from bug and fault
        tracking so they never count as defects. Add or edit with the{" "}
        <code className="text-xs">add_idea</code> / <code className="text-xs">update_idea</code> MCP
        tools.
      </p>

      <div className="flex flex-wrap gap-2 mb-6">
        <Chip href="/admin/ideas" active={!status && !product} label={`All (${total})`} />
        {IDEA_STATUSES.map((s) => (
          <Chip
            key={s}
            href={`/admin/ideas?status=${s}`}
            active={status === s}
            label={`${s} (${countOf(s)})`}
          />
        ))}
        <span className="text-muted-foreground mx-2">·</span>
        {IDEA_PRODUCTS.map((p) => (
          <Chip key={p} href={`/admin/ideas?product=${p}`} active={product === p} label={p} />
        ))}
      </div>

      {rows.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No ideas match the current filter.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <h2 className="text-sm font-semibold text-foreground">
              {rows.length} idea{rows.length === 1 ? "" : "s"}
            </h2>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y divide-gray-100">
              {rows.map((r) => {
                const refs = parseRefs(r.relatedRefs);
                return (
                  <li key={r.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-foreground">
                          {r.title}{" "}
                          <span className="text-xs text-muted-foreground">
                            · {r.product}
                            {r.area ? ` · ${r.area}` : ""} · {r.votes} vote
                            {r.votes === 1 ? "" : "s"}
                          </span>
                        </p>
                        {r.description && (
                          <p className="mt-1 text-sm text-muted-foreground whitespace-pre-wrap">
                            {r.description}
                          </p>
                        )}
                        <p className="mt-1 text-xs text-muted-foreground">
                          {r.sourceType}
                          {r.sourcePerson ? ` · ${r.sourcePerson}` : ""}
                          {r.sourceRef ? ` · ${r.sourceRef}` : ""} ·{" "}
                          {r.createdAt.toISOString().slice(0, 10)}
                          {r.linkedIssue ? ` · → ${r.linkedIssue}` : ""}
                        </p>
                        {refs.length > 0 && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            Related: {refs.join(", ")}
                          </p>
                        )}
                        {r.notes && <p className="mt-1 text-xs text-foreground">{r.notes}</p>}
                      </div>
                      <form
                        method="post"
                        action={`/api/admin/ideas/${r.id}/status`}
                        className="flex items-center gap-2"
                      >
                        <input type="hidden" name="back" value={back} />
                        <label className="sr-only" htmlFor={`status-${r.id}`}>
                          Status
                        </label>
                        <select
                          id={`status-${r.id}`}
                          name="status"
                          defaultValue={r.status}
                          className="rounded border border-border px-2 py-1 text-sm"
                        >
                          {IDEA_STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </select>
                        <button
                          type="submit"
                          className="rounded bg-secondary px-3 py-1 text-xs font-medium text-secondary-foreground hover:bg-secondary/90"
                        >
                          Save
                        </button>
                      </form>
                    </div>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Chip({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      className={`text-xs px-3 py-1 rounded-full transition-colors ${
        active
          ? "bg-secondary text-secondary-foreground"
          : "bg-muted text-foreground hover:bg-muted"
      }`}
    >
      {label}
    </Link>
  );
}
