/**
 * OPE-191 — "New This Week" vendor digest content (increment 1).
 *
 * The vendor-framed inner HTML that goes inside the branded newsletter shell
 * (`newsletterLayout`, OPE-232) with the wordmark "New This Week". Distinct from
 * the attendee weekend digest: it leads with what an EXHIBITOR weighs — fit,
 * crowd/ROI, indoor vs outdoor, and lead time to apply — not experiential copy.
 *
 * Pure and side-effect-free so it's fully unit-testable; the selection query and
 * the Monday send wiring (increment 2) live elsewhere.
 */
const SITE = "https://meetmeatthefair.com";

export interface VendorDigestEvent {
  name: string;
  slug: string;
  /** null → the date is unset (shown as "Dates TBC"). */
  startDate: Date | null;
  /** Multi-day shows render a range; null → single day. */
  endDate: Date | null;
  /**
   * OPE-360 — whether the DATES are uncertain. Previously this was
   * `isTentative`, keyed off `status === 'TENTATIVE'`, which was wrong:
   * TENTATIVE conflates "we don't know the dates" with "record not yet
   * promoted / needs enrichment". Celebrate Craft Holiday Fair is TENTATIVE
   * only because it lacks an image and a price — its dates are confirmed and
   * independently verified against the organiser's site — yet the digest told
   * exhibitors "Dates TBC", undercutting the runway-to-apply value that is the
   * entire point of this newsletter.
   *
   * Now keyed off date certainty alone.
   */
  datesUnconfirmed: boolean;
  categories: string[];
  commercialVendorsAllowed: boolean | null;
  estimatedAttendance: number | null;
  /** SMALL | MEDIUM | LARGE | MAJOR (free text; shown as-is when set). */
  eventScale: string | null;
  /** INDOOR | OUTDOOR | MIXED. */
  indoorOutdoor: string | null;
  applicationUrl: string | null;
  sourceUrl: string | null;
  promoterWebsite: string | null;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Only http(s) — a stored URL can be junk; never emit a non-web scheme. */
function httpOrNull(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Where "Apply" points, resolved down the chain the ticket specifies:
 * application_url → source_url → promoter website → the MMATF event page.
 * The event page is the always-present floor, so this never returns empty.
 */
export function resolveApplyLink(e: VendorDigestEvent): string {
  return (
    httpOrNull(e.applicationUrl) ??
    httpOrNull(e.sourceUrl) ??
    httpOrNull(e.promoterWebsite) ??
    `${SITE}/events/${e.slug}`
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Sat, Nov 21" — weekday included because a vendor plans around weekends. */
function dayLabel(d: Date): string {
  return `${DAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/**
 * "Sat, Nov 21 – Sun, Nov 22, 2026" · "Sat, Nov 21, 2026" · "Dates TBC".
 *
 * "Dates TBC" now means exactly what it says: the dates are not confirmed, or
 * there is no start date at all. An event can be TENTATIVE and still have firm
 * dates (see `datesUnconfirmed`).
 */
export function formatShowDate(e: VendorDigestEvent): string {
  if (e.datesUnconfirmed || !e.startDate) return "Dates TBC";
  const start = e.startDate;
  const year = start.getUTCFullYear();
  const end = e.endDate;
  // Same-day end dates are common in the data; render those as a single day
  // rather than "Nov 21 – Nov 21".
  if (end && end.getTime() > start.getTime()) {
    return `${dayLabel(start)} – ${dayLabel(end)}, ${end.getUTCFullYear()}`;
  }
  return `${dayLabel(start)}, ${year}`;
}

/** "in 3 weeks" / "in 5 months" — the runway-to-apply chip. */
export function leadTimeLabel(startDate: Date | null, now: Date): string | null {
  if (!startDate) return null;
  const days = Math.round((startDate.getTime() - now.getTime()) / 86_400_000);
  if (days < 0) return null;
  if (days < 14) return `in ${Math.max(1, days)} day${days === 1 ? "" : "s"}`;
  if (days < 60) return `in ${Math.round(days / 7)} weeks`;
  return `in ${Math.round(days / 30)} months`;
}

function crowdSignal(e: VendorDigestEvent): string | null {
  if (e.estimatedAttendance && e.estimatedAttendance > 0) {
    return `~${e.estimatedAttendance.toLocaleString("en-US")} attendees`;
  }
  if (e.eventScale) return `${e.eventScale.toLowerCase()} show`;
  return null;
}

function fitLine(e: VendorDigestEvent): string | null {
  const parts: string[] = [];
  if (e.categories.length > 0) parts.push(e.categories.slice(0, 4).join(", "));
  if (e.commercialVendorsAllowed) parts.push("commercial vendors welcome");
  return parts.length ? parts.join(" · ") : null;
}

function card(e: VendorDigestEvent, now: Date): string {
  const apply = resolveApplyLink(e);
  const lead = leadTimeLabel(e.datesUnconfirmed ? null : e.startDate, now);
  const chips = [
    crowdSignal(e),
    e.indoorOutdoor ? e.indoorOutdoor.toLowerCase() : null,
    lead ? `apply ${lead}` : null,
  ].filter((c): c is string => Boolean(c));
  const fit = fitLine(e);
  return `
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 16px;border:1px solid #E5DFD6;border-radius:8px;">
    <tr><td style="padding:16px 18px;">
      <div style="font-size:18px;font-weight:700;color:#1f3a2d;">
        <a href="${esc(`${SITE}/events/${e.slug}`)}" style="color:#1f3a2d;text-decoration:none;">${esc(e.name)}</a>
      </div>
      <div style="font-size:13px;color:#5c6b60;margin-top:2px;">${esc(formatShowDate(e))}</div>
      ${fit ? `<div style="font-size:14px;color:#2A2521;margin-top:8px;">${esc(fit)}</div>` : ""}
      ${
        chips.length
          ? `<div style="margin-top:8px;font-size:12px;color:#5c6b60;">${chips
              .map((c) => esc(c))
              .join(" &nbsp;·&nbsp; ")}</div>`
          : ""
      }
      <div style="margin-top:12px;">
        <a href="${esc(apply)}" style="display:inline-block;padding:8px 16px;background:#1f3a2d;color:#e8c86a;font-weight:600;text-decoration:none;border-radius:6px;font-size:14px;">Apply for a booth →</a>
      </div>
    </td></tr>
  </table>`;
}

/**
 * The digest inner HTML, or null when there are no shows (the caller must NOT
 * send an empty issue — that's the §2 "0 rows → skip" rule).
 */
export function renderVendorDigestContent(events: VendorDigestEvent[], now: Date): string | null {
  if (events.length === 0) return null;

  const intro = `<p style="font-size:16px;line-height:1.55;color:#2A2521;margin:0 0 20px;">New shows just added to Meet Me at the Fair — with runway to apply for a booth. ${events.length} this week:</p>`;

  const glance = `
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 24px;font-size:13px;">
    ${events
      .map(
        (e) => `<tr>
      <td style="padding:6px 0;border-bottom:1px solid #EFEAE0;color:#1f3a2d;font-weight:600;">${esc(e.name)}</td>
      <td style="padding:6px 0;border-bottom:1px solid #EFEAE0;color:#5c6b60;text-align:right;white-space:nowrap;">${esc(formatShowDate(e))}</td>
    </tr>`
      )
      .join("")}
  </table>`;

  const cards = events.map((e) => card(e, now)).join("");
  return `${intro}${glance}${cards}`;
}
