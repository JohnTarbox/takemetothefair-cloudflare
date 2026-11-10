"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import {
  AdminPagedTable,
  type AdminColumn,
  type AdminFilter,
} from "@/components/admin/admin-paged-table";
import type { PromoterQualityRow, Tier } from "@/lib/admin-list/promoter-quality";

const FILTERS: AdminFilter[] = [
  {
    param: "tier",
    allLabel: "All tiers",
    options: [
      { value: "T1", label: "T1 clean" },
      { value: "T2", label: "T2 watch" },
      { value: "T3", label: "T3 risky" },
    ],
  },
];

function pct(n: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((n / total) * 1000) / 10;
}

function Num({ value, share, muted }: { value: number; share?: number; muted?: boolean }) {
  return (
    <span className={`tabular-nums ${muted ? "text-muted-foreground" : "text-foreground"}`}>
      {value.toLocaleString()}
      {share != null && share > 0 && (
        <span className="ml-1 text-xs text-muted-foreground">({share}%)</span>
      )}
    </span>
  );
}

function TierBadge({ tier }: { tier: Tier }) {
  const cls =
    tier === "T1"
      ? "bg-green-50 text-green-800 border-green-300"
      : tier === "T2"
        ? "bg-amber-50 text-amber-800 border-amber-300"
        : "bg-red-50 text-red-800 border-red-300";
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium border ${cls}`}>
      {tier}
    </span>
  );
}

function ConcernBadge({ value }: { value: number }) {
  // Same color thresholds as source-quality for consistency.
  const cls =
    value >= 25
      ? "bg-red-50 text-red-800 border-red-300"
      : value >= 10
        ? "bg-amber-50 text-amber-800 border-amber-300"
        : value > 0
          ? "bg-info-soft text-navy-dark border-info-soft"
          : "bg-green-50 text-green-800 border-green-300";
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded text-xs font-medium border tabular-nums ${cls}`}
    >
      {value}%
    </span>
  );
}

function TierStat({ label, value, tier }: { label: string; value: number; tier?: Tier }) {
  const cls = !tier
    ? "text-foreground"
    : tier === "T1"
      ? "text-green-700"
      : tier === "T2"
        ? "text-amber-700"
        : "text-red-700";
  return (
    <div>
      <p className={`text-2xl font-bold tabular-nums ${cls}`}>{value.toLocaleString()}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

const numeric = (
  key: keyof PromoterQualityRow & string,
  label: string,
  opts: { share?: boolean; muted?: boolean } = {}
): AdminColumn<PromoterQualityRow> => ({
  key,
  label,
  sortKey: key,
  cell: (r) => (
    <Num
      value={r[key] as number}
      share={opts.share ? pct(r[key] as number, r.total) : undefined}
      muted={opts.muted}
    />
  ),
});

const COLUMNS: AdminColumn<PromoterQualityRow>[] = [
  {
    key: "promoter",
    label: "Promoter",
    sortKey: "promoter",
    cell: (r) => (
      <div>
        <Link
          href={`/promoters/${r.promoterSlug}`}
          target="_blank"
          rel="noreferrer"
          className="text-royal hover:underline font-medium"
        >
          {r.promoterName}
        </Link>
        <div className="text-xs text-muted-foreground font-mono">{r.promoterSlug}</div>
      </div>
    ),
  },
  { key: "tier", label: "Tier", sortKey: "tier", cell: (r) => <TierBadge tier={r.tier} /> },
  numeric("total", "Total"),
  numeric("rejected", "Rejected", { share: true }),
  numeric("cancelled", "Cancelled", { share: true }),
  numeric("postponed", "Postponed", { share: true }),
  numeric("gateFlagged", "Flagged", { share: true }),
  numeric("unresolvedDrift", "Drift", { share: true }),
  numeric("imageless", "Imageless", { share: true, muted: true }),
  numeric("avgCompleteness", "Avg complete"),
  {
    key: "concernPct",
    label: "Concern",
    sortKey: "concernPct",
    cell: (r) => <ConcernBadge value={r.concernPct} />,
  },
];

export function PromoterQualityTable() {
  const [stats, setStats] = useState<Record<string, number>>({});
  return (
    <>
      <Card>
        <CardContent>
          <div className="flex flex-wrap items-center gap-6 py-2">
            <TierStat label="T1 clean" value={stats.T1 ?? 0} tier="T1" />
            <TierStat label="T2 watch" value={stats.T2 ?? 0} tier="T2" />
            <TierStat label="T3 risky" value={stats.T3 ?? 0} tier="T3" />
            <TierStat label="Total tracked" value={stats.tracked ?? 0} />
          </div>
        </CardContent>
      </Card>
      <AdminPagedTable<PromoterQualityRow>
        endpoint="/api/admin/promoter-quality"
        columns={COLUMNS}
        rowKey={(r) => r.id}
        noun="promoter"
        searchPlaceholder="Search promoters by name…"
        filters={FILTERS}
        defaultSort={{ column: "", direction: "asc" }}
        onData={(data) => setStats(data.stats ?? {})}
      />
    </>
  );
}
