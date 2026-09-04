/**
 * OPE-770 — the daily correspondent briefing, as a PAGE.
 *
 * Three lines per external email so answering costs five minutes instead of
 * forty. Inflow is ~3 external non-spam emails a week, so the bottleneck was
 * never throughput — it was recognition, and 35 of 46 people never heard from a
 * human.
 *
 * ⚠️ Two things this page deliberately does not do:
 *
 * 1. **It generates no prose.** No suggested reply, no summary of what the
 *    sender wants, no confidence score. 90.7% of live events claim confirmed
 *    dates with no citation, so a drafted answer quoting our stored record
 *    would be confidently wrong to a stranger. Every cell below is a row we
 *    already hold or a count of rows we already hold.
 * 2. **It is not a scheduled email.** The ticket's own tiebreak: a page nobody
 *    opens costs nothing; a daily email nobody reads trains John to ignore the
 *    channel. Nothing here sends, and nothing here is on a cron.
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  buildCorrespondentBriefing,
  ACK_ONLY_STALE_HOURS,
  type CorrespondentRow,
} from "@/lib/correspondents/briefing";

export const dynamic = "force-dynamic";

interface SearchParams {
  days?: string;
}

function IdentityCell({ row }: { row: CorrespondentRow }) {
  if (row.matchedEntityType && row.matchBasis && row.matchBasis !== "none") {
    return (
      <span>
        <Badge>{row.matchedEntityType}</Badge>{" "}
        <span className="text-muted-foreground text-xs">via {row.matchBasis}</span>
      </span>
    );
  }
  // `null` (row predates capture) and 'none' (we looked, found nobody) are
  // different facts and are shown as different words. Collapsing them would
  // make an unrun matcher look like a stranger.
  return (
    <span className="text-muted-foreground text-xs">
      {row.matchBasis === "none" ? "no match" : "not resolved"}
    </span>
  );
}

function ContactCell({ row }: { row: CorrespondentRow }) {
  return (
    <span className="text-xs">
      {row.isFirstContact ? (
        <strong>first contact</strong>
      ) : (
        <>{row.priorMessageCount} messages all-time</>
      )}
      {row.lastOutboundAt ? (
        <>
          {" · last out: "}
          {row.ackOnly ? (
            <span className="text-amber-700">{row.lastOutboundSource} (auto)</span>
          ) : (
            row.lastOutboundSource
          )}
        </>
      ) : (
        <span className="text-amber-700"> · never written to</span>
      )}
    </span>
  );
}

function Row({ row }: { row: CorrespondentRow }) {
  return (
    <tr className="border-b align-top">
      <td className="py-2 pr-3 text-xs whitespace-nowrap">
        {row.receivedAt.toISOString().slice(0, 10)}
      </td>
      <td className="py-2 pr-3 text-sm">
        <Link href={`/admin/inbound-emails/${row.inboundEmailId}`} className="underline">
          {row.fromAddress}
        </Link>
        <div className="text-muted-foreground text-xs">{row.subject ?? "(no subject)"}</div>
      </td>
      <td className="py-2 pr-3 text-xs">{row.intent ?? "—"}</td>
      <td className="py-2 pr-3">
        <IdentityCell row={row} />
      </td>
      <td className="py-2 pr-3 text-xs">
        {/* Absent rather than a fabricated "unknown" that reads as reassurance. */}
        {row.senderAuth ?? <span className="text-muted-foreground">—</span>}
      </td>
      <td className="py-2">
        <ContactCell row={row} />
      </td>
    </tr>
  );
}

export default async function AdminCorrespondentsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await auth();
  if (session?.user?.role !== "ADMIN") redirect("/");

  const params = await searchParams;
  const windowDays = Math.min(Math.max(Number(params.days) || 7, 1), 90);
  const briefing = await buildCorrespondentBriefing(getCloudflareDb(), { windowDays });

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Correspondents</h1>
        <p className="text-muted-foreground text-sm">
          External inbound over the last {briefing.windowDays} days. Facts only — no drafted
          replies.{" "}
          {[7, 14, 30].map((d) => (
            <Link key={d} href={`?days=${d}`} className="ml-2 underline">
              {d}d
            </Link>
          ))}
        </p>
      </div>

      <Card>
        <CardHeader>
          <h2 className="font-medium">
            Waiting on us{" "}
            <span className="text-muted-foreground text-sm font-normal">
              (no human reply, or an auto-ack standing over {ACK_ONLY_STALE_HOURS}h)
            </span>
          </h2>
        </CardHeader>
        <CardContent>
          {briefing.waiting.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Nobody is waiting in this window.{" "}
              {/*
                The positive landmark. "0 waiting" is only meaningful next to
                what was examined — half of inbound_emails is our own
                notify@→alert@ traffic, so an empty list and a broken filter
                look identical without these two numbers.
              */}
              <span className="text-xs">
                ({briefing.scannedTotal} inbound scanned, {briefing.filteredSystemSenders} system
                senders filtered, {briefing.rows.length} external)
              </span>
            </p>
          ) : (
            <table className="w-full text-left">
              <tbody>
                {briefing.waiting.map((r) => (
                  <Row key={r.inboundEmailId} row={r} />
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="font-medium">
            All external correspondents{" "}
            <span className="text-muted-foreground text-sm font-normal">
              ({briefing.rows.length} of {briefing.scannedTotal} inbound;{" "}
              {briefing.filteredSystemSenders} system senders filtered)
            </span>
          </h2>
        </CardHeader>
        <CardContent>
          {briefing.rows.length === 0 ? (
            <p className="text-muted-foreground text-sm">No external mail in this window.</p>
          ) : (
            <table className="w-full text-left">
              <thead>
                <tr className="text-muted-foreground border-b text-xs">
                  <th className="py-1 pr-3 font-normal">received</th>
                  <th className="py-1 pr-3 font-normal">from / subject</th>
                  <th className="py-1 pr-3 font-normal">intent</th>
                  <th className="py-1 pr-3 font-normal">who they are</th>
                  <th className="py-1 pr-3 font-normal">auth</th>
                  <th className="py-1 font-normal">prior contact</th>
                </tr>
              </thead>
              <tbody>
                {briefing.rows.map((r) => (
                  <Row key={r.inboundEmailId} row={r} />
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
