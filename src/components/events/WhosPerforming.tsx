/**
 * OPE-114 §5.1 — public "Who's Performing" block on the event page. CONFIRMED
 * acts only (the loader filters), grouped by day, billing-ordered (headliner
 * first). The parent omits this entirely when there are no confirmed acts.
 */
import Link from "next/link";
import Image from "next/image";
import { Music } from "lucide-react";
import type { EventPerformerRow } from "@/lib/performers/load-event-performers";

const BILLING_RANK: Record<string, number> = { HEADLINER: 0, FEATURED: 1, SUPPORTING: 2 };
const CATEGORY_LABEL: Record<string, string> = {
  MUSIC: "Music",
  ANIMAL_SHOW: "Animal show",
  MAGIC: "Magic",
  COMEDY: "Comedy",
  CIRCUS: "Circus",
  DANCE: "Dance",
  THEATER: "Theater",
  EDUCATIONAL: "Educational",
  CHILDRENS: "Children's",
  DEMONSTRATION: "Demonstration",
  OTHER: "Entertainment",
};

function formatTime(sec: number | null): string | null {
  if (sec == null) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/New_York",
    }).format(new Date(sec * 1000));
  } catch {
    return null;
  }
}

function formatDay(date: string): string {
  // date is YYYY-MM-DD; format without a timezone shift.
  const [y, m, d] = date.split("-").map(Number);
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(y, m - 1, d)));
  } catch {
    return date;
  }
}

function sortAppearances(a: EventPerformerRow, b: EventPerformerRow): number {
  return (
    (BILLING_RANK[a.billing ?? ""] ?? 3) - (BILLING_RANK[b.billing ?? ""] ?? 3) ||
    (a.performanceStart ?? 0) - (b.performanceStart ?? 0) ||
    a.performerName.localeCompare(b.performerName)
  );
}

function Card({ p }: { p: EventPerformerRow }) {
  const time = formatTime(p.performanceStart);
  return (
    <div className="flex items-center gap-3 rounded-lg border p-3">
      {p.imageUrl ? (
        <Image
          src={p.imageUrl}
          alt={p.performerName}
          width={56}
          height={56}
          className="h-14 w-14 rounded-full object-cover"
        />
      ) : (
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
          <Music className="h-6 w-6 text-muted-foreground" />
        </div>
      )}
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Link href={`/performers/${p.performerSlug}`} className="font-medium hover:underline">
            {p.performerName}
          </Link>
          {p.billing === "HEADLINER" && (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-800">
              Headliner
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {[p.actCategory ? (CATEGORY_LABEL[p.actCategory] ?? p.actCategory) : null, time, p.stage]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>
    </div>
  );
}

export function WhosPerforming({ performers }: { performers: EventPerformerRow[] }) {
  if (!performers || performers.length === 0) return null;

  // Group by day (null day → an "unscheduled" bucket, shown last).
  const byDay = new Map<string, EventPerformerRow[]>();
  const UNDATED = "__undated__";
  for (const p of performers) {
    const key = p.dayDate ?? UNDATED;
    const arr = byDay.get(key) ?? [];
    arr.push(p);
    byDay.set(key, arr);
  }
  const dayKeys = [...byDay.keys()].sort((a, b) => {
    if (a === UNDATED) return 1;
    if (b === UNDATED) return -1;
    return a.localeCompare(b);
  });
  const multiDay = dayKeys.filter((k) => k !== UNDATED).length > 1;

  return (
    <section aria-labelledby="whos-performing" className="space-y-4">
      <h2 id="whos-performing" className="flex items-center gap-2 text-xl font-semibold">
        <Music className="h-5 w-5" /> Who&apos;s Performing
      </h2>
      {dayKeys.map((key) => {
        const acts = [...(byDay.get(key) ?? [])].sort(sortAppearances);
        return (
          <div key={key} className="space-y-2">
            {multiDay && key !== UNDATED && (
              <h3 className="text-sm font-medium text-muted-foreground">{formatDay(key)}</h3>
            )}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {acts.map((p) => (
                <Card key={p.id} p={p} />
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}
