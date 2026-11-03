/**
 * OPE-1511 — the contact relationship scorecard. John, 2026-10-20: metrics and
 * continuous improvement for how we manage contacts and correspondence. The
 * data lives in five tables and nothing rolled it up.
 *
 * Read-only. Every number is ONE named query in `CONTACT_SCORECARD_QUERIES` below, and the tool
 * description prints them, so any figure can be reproduced by hand against D1
 * (the ticket's acceptance). Rates are NULL on an empty denominator, never 0 —
 * the `get_promoter_outreach_metrics` convention: "no contact mail" is not
 * "we answered 0% of it".
 *
 * Definitions, stated once because each is a choice:
 *  - CONTACT: a `promoter_contacts` row whose status is not `rejected`.
 *  - CONTACT EMAIL: an inbound PARENT row (`parent_email_id IS NULL`, so one
 *    email split into several intent rows counts once) from a contact address.
 *  - HUMAN REPLY: a `sent` ledger row to that address after the email arrived,
 *    whose source is `reply:manual*` or `operator:outbound` (an approved draft).
 *    ⚠️ Replies sent from Gmail never reach the ledger, so responsiveness is a
 *    FLOOR, not a measurement of everything John answered.
 *  - CONTACT CITATION: a citation whose source_url is an admin inbound link
 *    (any of the three shapes below, all ending in the inbound uuid) for a
 *    contact email. WEBSITE CITATION:
 *    `source_type = 'official_website'`.
 *  - FLAGGED: an `event_discrepancies` row on the same event naming the
 *    citation's source as its divergent source (discrepancies carry a field
 *    class, not a citation id, so this is the closest exact join available).
 */
import { sql, type SQL } from "drizzle-orm";

/**
 * Anything that can run a raw SQL statement and return rows: the MCP Worker's
 * D1 drizzle, the app's `getCloudflareDb()`, and the better-sqlite3 test DB.
 */
export interface ScorecardDb {
  all<T = unknown>(query: SQL): Promise<T[]> | T[];
}

const DAY = 86_400;

/** US federal holidays observed (America/New_York calendar dates), 2026–2027. */
const HOLIDAYS = new Set([
  "2026-01-01",
  "2026-01-19",
  "2026-02-16",
  "2026-05-25",
  "2026-06-19",
  "2026-07-03",
  "2026-09-07",
  "2026-10-12",
  "2026-11-11",
  "2026-11-26",
  "2026-12-25",
  "2027-01-01",
  "2027-01-18",
  "2027-02-15",
  "2027-05-31",
  "2027-06-18",
  "2027-07-05",
  "2027-09-06",
  "2027-10-11",
  "2027-11-11",
  "2027-11-25",
  "2027-12-24",
]);

const NY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
});

function nyDay(d: Date): { date: string; weekday: string } {
  const parts = Object.fromEntries(NY.formatToParts(d).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday: parts.weekday };
}

export function isBusinessDay(d: Date): boolean {
  const { date, weekday } = nyDay(d);
  return weekday !== "Sat" && weekday !== "Sun" && !HOLIDAYS.has(date);
}

/**
 * The moment `n` business days after `from`: step 24h at a time and count only
 * New York business days. Mail that arrives on a Saturday is due by the end of
 * the same clock time on Monday + (n−1) business days — close enough for a
 * 1- or 2-day target, and stated rather than hidden.
 */
export function addBusinessDays(from: Date, n: number): Date {
  let t = from.getTime();
  let left = n;
  while (left > 0) {
    t += DAY * 1000;
    if (isBusinessDay(new Date(t))) left--;
  }
  return new Date(t);
}

const rate = (num: number, den: number): number | null =>
  den > 0 ? Math.round((num / den) * 1000) / 1000 : null;

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const CONTACT_ADDRESSES = `SELECT lower(trim(email)) FROM promoter_contacts WHERE status != 'rejected'`;
const HUMAN_SOURCE = `(l.source LIKE 'reply:manual%' OR l.source = 'operator:outbound')`;
/** The inbound id at the end of an admin inbound link. Three shapes are in prod
 *  (`/admin/inbound/<id>`, `/admin/inbound-emails?id=<id>`, OPE-1506's
 *  `/admin/inbound-emails#<id>`) and every one ENDS with the 36-char uuid. */
const INBOUND_LINK = `c.source_url LIKE '%/admin/inbound%'`;
const INBOUND_LINK_ID = `substr(c.source_url, -36)`;

/**
 * The queries, by name. `:from` / `:to` are the window bounds and `:now` the
 * read time, all unix seconds. The tool description prints these verbatim.
 */
export const CONTACT_SCORECARD_QUERIES = {
  contacts_by_status: `SELECT status, COUNT(*) n FROM promoter_contacts GROUP BY status`,
  upcoming_coverage: `SELECT COUNT(*) upcoming,
  SUM(EXISTS (SELECT 1 FROM promoter_contacts pc WHERE pc.promoter_id = e.promoter_id AND pc.status = 'validated')) covered
FROM events e WHERE e.status = 'APPROVED' AND e.merged_into IS NULL
  AND e.start_date >= :now AND e.start_date < :now + 180*86400`,
  contact_emails: `SELECT i.id, i.received_at, lower(trim(i.from_address)) addr,
  (SELECT MIN(l.sent_at) FROM email_send_ledger l WHERE lower(l.recipient) = lower(trim(i.from_address))
     AND l.status = 'sent' AND l.sent_at >= i.received_at AND ${HUMAN_SOURCE}) first_human_reply,
  EXISTS (SELECT 1 FROM support_obligations o WHERE o.inbound_email_id = i.id
     OR o.inbound_email_id IN (SELECT k.id FROM inbound_emails k WHERE k.parent_email_id = i.id)) has_obligation
FROM inbound_emails i WHERE i.parent_email_id IS NULL
  AND lower(trim(i.from_address)) IN (${CONTACT_ADDRESSES})
  AND i.received_at >= :from AND i.received_at < :to`,
  outreach_asks: `SELECT a.id, a.status, a.sent_at, COALESCE(r.received_at, a.outcome_at) answered_at
FROM promoter_outreach_attempts a LEFT JOIN inbound_emails r ON r.id = a.inbound_email_id
WHERE a.sent_at IS NOT NULL AND a.sent_at >= :from AND a.sent_at < :to`,
  asks_open_over_21d: `SELECT id FROM promoter_outreach_attempts WHERE status = 'sent' AND sent_at < :now - 21*86400`,
  fields_applied: `SELECT json_extract(payload_json, '$.basis') basis, COUNT(*) matches,
  SUM(json_array_length(json_extract(payload_json, '$.fields'))) fields
FROM admin_actions WHERE action = 'dedup.enrich_applied' AND created_at >= :from AND created_at < :to
GROUP BY basis`,
  events_created_from_contact_mail: `SELECT COUNT(DISTINCT i.resulting_event_id) n FROM inbound_emails i
WHERE i.resulting_event_id IS NOT NULL AND lower(trim(i.from_address)) IN (${CONTACT_ADDRESSES})
  AND i.received_at >= :from AND i.received_at < :to`,
  upcoming_start_date_from_contact: `SELECT COUNT(DISTINCT e.id) upcoming,
  COUNT(DISTINCT CASE WHEN EXISTS (SELECT 1 FROM event_data_citations c JOIN inbound_emails ci ON ci.id = ${INBOUND_LINK_ID}
    WHERE c.event_id = e.id AND c.field_name = 'start_date' AND c.state = 'active' AND ${INBOUND_LINK}
      AND lower(trim(ci.from_address)) IN (${CONTACT_ADDRESSES})) THEN e.id END) from_contact
FROM events e WHERE e.status = 'APPROVED' AND e.merged_into IS NULL AND e.start_date >= :now`,
  citation_accuracy: `SELECT CASE WHEN c.source_type = 'official_website' THEN 'website' ELSE 'contact' END class,
  COUNT(*) total,
  SUM(c.state = 'superseded') superseded,
  SUM(EXISTS (SELECT 1 FROM event_discrepancies d WHERE d.event_id = c.event_id AND d.divergent_source_url = c.source_url)) flagged
FROM event_data_citations c
WHERE c.source_type = 'official_website'
   OR (${INBOUND_LINK} AND EXISTS (SELECT 1 FROM inbound_emails ci
        WHERE ci.id = ${INBOUND_LINK_ID} AND lower(trim(ci.from_address)) IN (${CONTACT_ADDRESSES})))
GROUP BY class`,
  unlinked_outreach_replies: `SELECT DISTINCT i.id FROM inbound_emails i
JOIN email_send_ledger l ON l.source = 'email:promoter-outreach' AND l.provider_message_id IS NOT NULL
  AND (instr(coalesce(i.in_reply_to, ''), l.provider_message_id) > 0 OR instr(coalesce(i.email_references, ''), l.provider_message_id) > 0)
JOIN promoter_outreach_attempts a ON lower(a.to_address) = lower(l.recipient) AND a.status = 'sent' AND a.sent_at <= i.received_at`,
  validated_silent_12mo: `SELECT pc.id, pc.email FROM promoter_contacts pc WHERE pc.status = 'validated'
  AND COALESCE(pc.last_heard_at, 0) < :now - 365*86400
  AND NOT EXISTS (SELECT 1 FROM email_send_ledger l WHERE lower(l.recipient) = lower(pc.email)
    AND l.status = 'sent' AND l.sent_at >= :now - 365*86400)`,
} as const;

type Params = { from: number; to: number; now: number };

/** Bind `:from` / `:to` / `:now` as parameters (never interpolated text). */
function bind(text: string, p: Params): SQL {
  const parts = text.split(/(:from|:to|:now)\b/);
  const chunks: SQL[] = parts.map((part) => {
    if (part === ":from") return sql`${p.from}`;
    if (part === ":to") return sql`${p.to}`;
    if (part === ":now") return sql`${p.now}`;
    return sql.raw(part);
  });
  return sql.join(chunks, sql.raw(""));
}

async function q<T>(
  db: ScorecardDb,
  name: keyof typeof CONTACT_SCORECARD_QUERIES,
  p: Params
): Promise<T[]> {
  return Promise.resolve(db.all<T>(bind(CONTACT_SCORECARD_QUERIES[name], p)));
}

export interface WindowMetrics {
  window: { from: string; to: string; days: number };
  ourResponsiveness: {
    contactEmails: number;
    medianHoursToHumanReply: number | null;
    pctWithin1BusinessDay: number | null;
    pctNoReplyAfter2BusinessDays: number | null;
    noReplyAfter2BusinessDaysIds: string[];
  };
  theirResponsiveness: {
    asksSent: number;
    replied: number;
    replyRate: number | null;
    medianDaysToReply: number | null;
  };
  yield: {
    fieldsApplied: number;
    fieldsAppliedByBasis: Record<string, { matches: number; fields: number }>;
    eventsCreatedFromContactMail: number;
  };
  leakage: { contactEmailsWithoutObligation: string[] };
}

async function windowMetrics(db: ScorecardDb, p: Params, days: number): Promise<WindowMetrics> {
  const now = p.now * 1000;
  const mail = await q<{
    id: string;
    received_at: number;
    first_human_reply: number | null;
    has_obligation: number;
  }>(db, "contact_emails", p);
  const hours: number[] = [];
  let within1 = 0;
  let due2 = 0;
  const late2: string[] = [];
  for (const m of mail) {
    const received = new Date(m.received_at * 1000);
    const reply = m.first_human_reply != null ? m.first_human_reply * 1000 : null;
    if (reply != null) hours.push((reply - received.getTime()) / 3_600_000);
    if (reply != null && reply <= addBusinessDays(received, 1).getTime()) within1++;
    const deadline2 = addBusinessDays(received, 2).getTime();
    if (deadline2 <= now) {
      due2++;
      if (reply == null || reply > deadline2) late2.push(m.id);
    }
  }

  const asks = await q<{ id: string; status: string; sent_at: number; answered_at: number | null }>(
    db,
    "outreach_asks",
    p
  );
  // CUMULATIVE, like get_promoter_outreach_metrics: a confirmed ask was replied to.
  const answered = asks.filter((a) => a.status === "replied" || a.status === "confirmed");
  const replyDays = answered
    .filter((a) => a.answered_at != null)
    .map((a) => (a.answered_at! - a.sent_at) / DAY);

  const applied = await q<{ basis: string | null; matches: number; fields: number | null }>(
    db,
    "fields_applied",
    p
  );
  const byBasis: Record<string, { matches: number; fields: number }> = {};
  for (const r of applied) {
    byBasis[r.basis ?? "unknown"] = { matches: Number(r.matches), fields: Number(r.fields ?? 0) };
  }
  const [created] = await q<{ n: number }>(db, "events_created_from_contact_mail", p);

  return {
    window: {
      from: new Date(p.from * 1000).toISOString(),
      to: new Date(p.to * 1000).toISOString(),
      days,
    },
    ourResponsiveness: {
      contactEmails: mail.length,
      medianHoursToHumanReply: median(hours) == null ? null : Math.round(median(hours)! * 10) / 10,
      pctWithin1BusinessDay: rate(within1, mail.length),
      pctNoReplyAfter2BusinessDays: rate(late2.length, due2),
      noReplyAfter2BusinessDaysIds: late2,
    },
    theirResponsiveness: {
      asksSent: asks.length,
      replied: answered.length,
      replyRate: rate(answered.length, asks.length),
      medianDaysToReply:
        median(replyDays) == null ? null : Math.round(median(replyDays)! * 10) / 10,
    },
    yield: {
      fieldsApplied: Object.values(byBasis).reduce((s, b) => s + b.fields, 0),
      fieldsAppliedByBasis: byBasis,
      eventsCreatedFromContactMail: Number(created?.n ?? 0),
    },
    leakage: {
      contactEmailsWithoutObligation: mail
        .filter((m) => !Number(m.has_obligation))
        .map((m) => m.id),
    },
  };
}

export interface ContactScorecard {
  asOf: string;
  coverage: {
    contactsByStatus: Record<string, number>;
    contactsTotal: number;
    upcomingEvents180d: number;
    upcomingWithValidatedContact: number;
    pctUpcomingWithValidatedContact: number | null;
  };
  current: WindowMetrics;
  prior: WindowMetrics;
  allTime: {
    asksOpenOver21Days: string[];
    upcomingStartDateFromContact: { upcoming: number; fromContact: number; pct: number | null };
    accuracy: Record<
      "contact" | "website",
      {
        total: number;
        superseded: number;
        flagged: number;
        supersededRate: number | null;
        flaggedRate: number | null;
      }
    >;
    unlinkedOutreachReplies: string[];
    validatedContactsSilent12Months: Array<{ id: string; email: string }>;
  };
  caveat: string;
}

export async function computeContactScorecard(
  db: ScorecardDb,
  args: { windowDays: number; now?: Date }
): Promise<ContactScorecard> {
  const nowS = Math.floor((args.now ?? new Date()).getTime() / 1000);
  const w = args.windowDays * DAY;
  const cur: Params = { from: nowS - w, to: nowS, now: nowS };
  const pri: Params = { from: nowS - 2 * w, to: nowS - w, now: nowS };

  const statusRows = await q<{ status: string; n: number }>(db, "contacts_by_status", cur);
  const contactsByStatus = Object.fromEntries(statusRows.map((r) => [r.status, Number(r.n)]));
  const [cov] = await q<{ upcoming: number; covered: number | null }>(db, "upcoming_coverage", cur);
  const upcoming = Number(cov?.upcoming ?? 0);
  const covered = Number(cov?.covered ?? 0);

  const [startDate] = await q<{ upcoming: number; from_contact: number }>(
    db,
    "upcoming_start_date_from_contact",
    cur
  );
  const acc = await q<{
    class: "contact" | "website";
    total: number;
    superseded: number;
    flagged: number;
  }>(db, "citation_accuracy", cur);
  const accuracy = { contact: blankAcc(), website: blankAcc() };
  for (const r of acc) {
    const total = Number(r.total);
    accuracy[r.class] = {
      total,
      superseded: Number(r.superseded),
      flagged: Number(r.flagged),
      supersededRate: rate(Number(r.superseded), total),
      flaggedRate: rate(Number(r.flagged), total),
    };
  }

  return {
    asOf: new Date(nowS * 1000).toISOString(),
    coverage: {
      contactsByStatus,
      contactsTotal: Object.values(contactsByStatus).reduce((s, n) => s + n, 0),
      upcomingEvents180d: upcoming,
      upcomingWithValidatedContact: covered,
      pctUpcomingWithValidatedContact: rate(covered, upcoming),
    },
    current: await windowMetrics(db, cur, args.windowDays),
    prior: await windowMetrics(db, pri, args.windowDays),
    allTime: {
      asksOpenOver21Days: (await q<{ id: string }>(db, "asks_open_over_21d", cur)).map((r) => r.id),
      upcomingStartDateFromContact: {
        upcoming: Number(startDate?.upcoming ?? 0),
        fromContact: Number(startDate?.from_contact ?? 0),
        pct: rate(Number(startDate?.from_contact ?? 0), Number(startDate?.upcoming ?? 0)),
      },
      accuracy,
      unlinkedOutreachReplies: (await q<{ id: string }>(db, "unlinked_outreach_replies", cur)).map(
        (r) => r.id
      ),
      validatedContactsSilent12Months: await q<{ id: string; email: string }>(
        db,
        "validated_silent_12mo",
        cur
      ),
    },
    caveat:
      "Replies sent from Gmail never reach email_send_ledger, so our-responsiveness is a floor: " +
      "an email John answered from Gmail reads here as unanswered.",
  };

  function blankAcc(): ContactScorecard["allTime"]["accuracy"]["contact"] {
    return { total: 0, superseded: 0, flagged: 0, supersededRate: null, flaggedRate: null };
  }
}
