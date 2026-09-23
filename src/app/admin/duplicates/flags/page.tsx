/**
 * OPE-1117 — /admin/duplicates/flags, the queue `possible_duplicate_of` never had.
 *
 * Every row the OPE-627 detector flagged that no human has ruled on, soonest
 * event first, with both sides side by side and three verdicts. The detector's
 * base rate is 40% (4 true of 10 on OPE-627's census), so this is a list of
 * questions, not a list of defects — nothing here acts without a click.
 *
 * Shape follows /admin/claims (OPE-65). Server component; admin auth is
 * enforced by src/app/admin/layout.tsx. An empty queue renders a clean empty
 * state (the OPE-58 crash class).
 */
import Link from "next/link";
import { getCloudflareDb } from "@/lib/cloudflare";
import {
  DEFAULT_DUPLICATE_FLAG_ALERT_DAYS,
  listUnresolvedDuplicateFlags,
  loadDuplicateFlagAlertDays,
  type FlagSide,
} from "@/lib/duplicates/flag-queue";
import { formatDateRange } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DuplicateFlagActions } from "@/components/admin/DuplicateFlagActions";

export const dynamic = "force-dynamic";

function whenLabel(days: number | null): string {
  if (days === null) return "no date";
  if (days < 0) return `started ${-days}d ago`;
  if (days === 0) return "starts today";
  return `starts in ${days}d`;
}

function Side({ title, side }: { title: string; side: FlagSide | null }) {
  if (!side) {
    return (
      <div className="rounded border border-border p-3 text-sm text-muted-foreground">
        <p className="text-xs uppercase tracking-wide mb-1">{title}</p>
        The event this was flagged against no longer exists.
      </div>
    );
  }
  return (
    <div className="rounded border border-border p-3 text-sm space-y-1">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{title}</p>
      <p className="font-medium text-foreground">
        <Link href={`/events/${side.slug}`} target="_blank" className="underline">
          {side.name}
        </Link>{" "}
        <span className="text-xs text-muted-foreground">({side.status})</span>
      </p>
      <p className="text-muted-foreground">
        {side.startDate ? formatDateRange(side.startDate, side.endDate) : "No date"}
      </p>
      <p className="text-muted-foreground">{side.venue ?? "No venue"}</p>
      <p className="text-xs text-muted-foreground break-all">
        Source: {side.sourceName ?? "—"}
        {side.sourceUrl && (
          <>
            {" · "}
            <a href={side.sourceUrl} target="_blank" rel="noreferrer" className="underline">
              {side.sourceUrl}
            </a>
          </>
        )}
      </p>
      <p className="text-xs text-muted-foreground">
        <Link href={`/admin/events/${side.id}/edit`} className="underline">
          Edit
        </Link>
      </p>
    </div>
  );
}

export default async function AdminDuplicateFlagsPage() {
  const db = getCloudflareDb();
  const now = new Date();
  const [flags, alertDays] = await Promise.all([
    listUnresolvedDuplicateFlags(db, now),
    loadDuplicateFlagAlertDays(db).catch(() => DEFAULT_DUPLICATE_FLAG_ALERT_DAYS),
  ]);
  const urgent = flags.filter((f) => f.daysUntilStart !== null && f.daysUntilStart <= alertDays);
  const publiclyListed = flags.filter((f) => f.flagged.status !== "PENDING");

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-foreground">
          Possible duplicates awaiting a verdict
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Events the intake duplicate check flagged as possibly the same as an existing event. The
          check is right about 4 times in 10 — a large fairground really does host several events at
          once — so each flag needs a person to decide. Nothing here merges on its own.{" "}
          <Link href="/admin/duplicates" className="underline">
            Similarity sweep
          </Link>
        </p>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Stat label="Awaiting a verdict" value={flags.length} />
        <Stat label={`Event within ${alertDays}d or started`} value={urgent.length} />
        <Stat label="Publicly listed while flagged" value={publiclyListed.length} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Flags</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {flags.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No unresolved duplicate flags. New flags appear here as soon as intake raises them.
            </p>
          ) : (
            flags.map((f) => (
              <section
                key={f.flagged.id}
                className="border-b border-border pb-6 last:border-0 last:pb-0 space-y-3"
              >
                <p className="text-sm">
                  <span
                    className={
                      f.daysUntilStart !== null && f.daysUntilStart <= alertDays
                        ? "font-semibold text-red-700"
                        : "text-muted-foreground"
                    }
                  >
                    {whenLabel(f.daysUntilStart)}
                  </span>
                  <span className="text-muted-foreground">
                    {" · flagged "}
                    {f.flaggedAt ? f.flaggedAt.toISOString().slice(0, 10) : "—"}
                  </span>
                </p>
                <div className="grid md:grid-cols-2 gap-3">
                  <Side title="Flagged" side={f.flagged} />
                  <Side title="Possible duplicate of (keeper)" side={f.candidate} />
                </div>
                {f.candidate && (
                  <DuplicateFlagActions
                    eventId={f.flagged.id}
                    candidateId={f.candidate.id}
                    eventName={f.flagged.name}
                    candidateName={f.candidate.name}
                  />
                )}
              </section>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-2xl font-semibold tabular-nums mt-1 text-foreground">{value}</p>
      </CardContent>
    </Card>
  );
}
