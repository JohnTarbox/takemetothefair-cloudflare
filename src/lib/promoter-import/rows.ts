/**
 * OPE-1618 — the season template and row validation.
 *
 * The template's columns are the contract: headers match case-insensitively,
 * with spaces / underscores / punctuation ignored and a few common aliases, so
 * a promoter's own sheet ("Event Name", "Start", "Town") still reads. Every
 * error names the row and the column, in words a promoter can act on.
 *
 * Values are parsed to the shapes the portal's own create form writes (dates
 * YYYY-MM-DD, times HH:MM, money in dollars, URLs http(s)). Nothing here
 * touches the database.
 */
import { createSlug } from "@takemetothefair/utils";
import { EVENT_CATEGORIES, partitionEventCategories } from "@takemetothefair/constants";
import { STATES, isStateCode, type StateCode } from "@/lib/states";

export interface TemplateColumn {
  key: ImportField;
  header: string;
  required: boolean;
  example: string;
  aliases?: string[];
}

export type ImportField =
  | "name"
  | "start_date"
  | "end_date"
  | "daily_hours"
  | "venue_name"
  | "address"
  | "city"
  | "state"
  | "zip"
  | "description"
  | "categories"
  | "admission"
  | "vendor_application_url"
  | "application_deadline"
  | "booth_fee_min"
  | "booth_fee_max"
  | "event_url"
  | "image_url";

export const TEMPLATE_COLUMNS: TemplateColumn[] = [
  {
    key: "name",
    header: "Event name",
    required: true,
    example: "Fall Craft Fair",
    aliases: ["name", "event", "title", "show", "show name"],
  },
  {
    key: "start_date",
    header: "Start date",
    required: true,
    example: "2027-10-02",
    aliases: ["start", "date", "first day"],
  },
  {
    key: "end_date",
    header: "End date",
    required: false,
    example: "2027-10-03",
    aliases: ["end", "last day"],
  },
  {
    key: "daily_hours",
    header: "Daily hours",
    required: false,
    example: "9am-4pm",
    aliases: ["hours", "time", "times"],
  },
  {
    key: "venue_name",
    header: "Venue name",
    required: false,
    example: "Town Hall",
    aliases: ["venue", "location", "place"],
  },
  {
    key: "address",
    header: "Address",
    required: false,
    example: "12 Main St",
    aliases: ["street", "street address"],
  },
  {
    key: "city",
    header: "City",
    required: true,
    example: "Concord",
    aliases: ["town", "city/town"],
  },
  { key: "state", header: "State", required: true, example: "NH", aliases: ["st"] },
  {
    key: "zip",
    header: "ZIP",
    required: false,
    example: "03301",
    aliases: ["zip code", "postal code", "zipcode"],
  },
  {
    key: "description",
    header: "Description",
    required: false,
    example: "60 juried artisans, food and music.",
    aliases: ["details", "about"],
  },
  {
    key: "categories",
    header: "Categories",
    required: false,
    example: "Craft Fair; Holiday Market",
    aliases: ["category", "type"],
  },
  {
    key: "admission",
    header: "Admission",
    required: false,
    example: "Free",
    aliases: ["admission price", "ticket price", "price", "cost"],
  },
  {
    key: "vendor_application_url",
    header: "Vendor application URL",
    required: false,
    example: "https://example.org/apply",
    aliases: ["application url", "vendor application", "apply url"],
  },
  {
    key: "application_deadline",
    header: "Application deadline",
    required: false,
    example: "2027-08-15",
    aliases: ["deadline", "vendor deadline"],
  },
  {
    key: "booth_fee_min",
    header: "Booth fee min",
    required: false,
    example: "75",
    aliases: ["booth fee", "vendor fee", "booth fee minimum"],
  },
  {
    key: "booth_fee_max",
    header: "Booth fee max",
    required: false,
    example: "125",
    aliases: ["booth fee maximum"],
  },
  {
    key: "event_url",
    header: "Event URL",
    required: false,
    example: "https://example.org/fall-fair",
    aliases: ["url", "website", "event page", "link"],
  },
  {
    key: "image_url",
    header: "Image URL",
    required: false,
    example: "https://example.org/poster.jpg",
    aliases: ["image", "photo", "poster url"],
  },
];

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** The downloadable template: headers (required ones marked *), one example row. */
export function templateCsv(): string {
  const header = TEMPLATE_COLUMNS.map((c) => csvCell(c.required ? `${c.header} *` : c.header));
  const example = TEMPLATE_COLUMNS.map((c) => csvCell(c.example));
  return `${header.join(",")}\r\n${example.join(",")}\r\n`;
}

/** A comparison key, not a stored slug: createSlug (#120) with hyphens as spaces. */
const headerKey = (h: string) => createSlug(h.replace(/\*/g, "")).replace(/-/g, " ");

/** Header row → column index per field. Unknown headers are reported, not fatal. */
export function mapHeaders(header: string[]): {
  index: Partial<Record<ImportField, number>>;
  unknown: string[];
  missingRequired: string[];
} {
  const lookup = new Map<string, ImportField>();
  for (const c of TEMPLATE_COLUMNS) {
    lookup.set(headerKey(c.header), c.key);
    lookup.set(headerKey(c.key), c.key);
    for (const a of c.aliases ?? []) if (!lookup.has(headerKey(a))) lookup.set(headerKey(a), c.key);
  }
  const index: Partial<Record<ImportField, number>> = {};
  const unknown: string[] = [];
  header.forEach((h, i) => {
    const k = lookup.get(headerKey(h));
    if (k && index[k] === undefined) index[k] = i;
    else if (h.trim()) unknown.push(h.trim());
  });
  const missingRequired = TEMPLATE_COLUMNS.filter(
    (c) => c.required && index[c.key] === undefined
  ).map((c) => c.header);
  return { index, unknown, missingRequired };
}

// ------------------------------------------------------------------ values

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const pad = (n: number) => String(n).padStart(2, "0");

const validYmd = (y: number, m: number, d: number): string | null => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
    ? `${y}-${pad(m)}-${pad(d)}`
    : null;
};

/**
 * A date cell → "YYYY-MM-DD". Accepts ISO, US M/D/YYYY (and M/D/YY), "June 5,
 * 2027", and an Excel serial number (days since 1899-12-30, which absorbs
 * Excel's 1900 leap-year bug for every date after Feb 1900).
 */
export function parseDateCell(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s);
  if (m) return validYmd(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (m) return validYmd(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1], +m[2]);
  m = /^(?:[a-z]+,?\s+)?([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i.exec(s);
  if (m) {
    const mi = MONTHS.findIndex((x) => x.startsWith(m![1].toLowerCase().slice(0, 3)));
    if (mi >= 0) return validYmd(+m[3], mi + 1, +m[2]);
  }
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const serial = Math.floor(Number(s));
    const d = new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000);
    return validYmd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  return null;
}

/** One clock time → minutes after midnight, and whether it is unambiguous (suffixed or 24h). */
function parseClock(raw: string): { mins: number; explicit: boolean } | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|noon)?$/i.exec(raw.trim());
  if (!m) return null;
  let h = +m[1];
  const min = m[2] ? +m[2] : 0;
  const suf = m[3]?.toLowerCase().replace(/\./g, "");
  if (min > 59 || h > 23) return null;
  if (suf === "noon") return h === 12 ? { mins: 720, explicit: true } : null;
  if (suf === "am" || suf === "pm") {
    if (h < 1 || h > 12) return null;
    if (suf === "am" && h === 12) h = 0;
    if (suf === "pm" && h !== 12) h += 12;
    return { mins: h * 60 + min, explicit: true };
  }
  // No suffix: only a 24-hour value (13–23, or 0) is unambiguous.
  return { mins: h * 60 + min, explicit: h > 12 || h === 0 };
}

const hhmm = (mins: number) => `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;

/**
 * "9am-4pm", "9:00 AM – 4:30 PM", "09:00-17:00", "10-4" → open/close HH:MM.
 * A bare close hour earlier than the open hour is read as PM ("10-4" = 10:00–16:00);
 * a range that still ends before it starts is an error, never a guess.
 */
export function parseHoursCell(raw: string): { open: string; close: string } | null {
  const s = raw
    .trim()
    .replace(/\s+to\s+/i, "-")
    .replace(/[–—]/g, "-");
  const parts = s.split("-").map((p) => p.trim());
  if (parts.length !== 2) return null;
  const a = parseClock(parts[0]);
  const b = parseClock(parts[1]);
  if (!a || !b) return null;
  let open = a.mins;
  let close = b.mins;
  // "9-4pm": the suffix on the close applies to an unsuffixed open only if it keeps open < close.
  if (!a.explicit && b.explicit && close >= 12 * 60 && open + 12 * 60 < close && open < 12 * 60) {
    // e.g. "1-4pm" → 13:00–16:00
    if (open < 7 * 60) open += 12 * 60;
  }
  if (!b.explicit && close <= open && close + 12 * 60 > open) close += 12 * 60;
  if (close <= open) return null;
  return { open: hhmm(open), close: hhmm(close) };
}

/** "$75", "75.00", "75" → 75. */
export function parseMoney(raw: string): number | null {
  const s = raw.trim().replace(/[$,\s]/g, "");
  if (!s) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  return Number(s);
}

/** "Free", "$5", "$5-$10", "5 to 10" → min/max dollars. */
export function parseAdmission(
  raw: string
): { min: number | null; max: number | null; free: boolean } | null {
  const s = raw.trim();
  if (!s) return { min: null, max: null, free: false };
  if (/^free\b/i.test(s)) return { min: 0, max: 0, free: true };
  const nums = [...s.matchAll(/\$?\s*(\d+(?:\.\d{1,2})?)/g)].map((m) => Number(m[1]));
  if (!nums.length) return null;
  return { min: Math.min(...nums), max: Math.max(...nums), free: false };
}

const isHttpUrl = (s: string) => {
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
};

function parseState(raw: string): StateCode | null {
  const s = raw.trim();
  if (isStateCode(s.toUpperCase())) return s.toUpperCase() as StateCode;
  const byName = (Object.entries(STATES) as Array<[StateCode, { name: string }]>).find(
    ([, v]) => v.name.toLowerCase() === s.toLowerCase()
  );
  return byName ? byName[0] : null;
}

// ------------------------------------------------------------------ rows

/** One spreadsheet row, parsed. `rowNumber` is the sheet's own (header = 1). */
export interface ImportRow {
  rowNumber: number;
  /** As read, by template field. */
  raw: Partial<Record<ImportField, string>>;
  errors: string[];
  /**
   * OPE-1620 — the same errors, each with the template field it is about (null
   * when it is about the row as a whole). The API answers 422 with these.
   */
  fieldErrors: Array<{ field: ImportField | null; message: string }>;
  /** Non-blocking: what the row loses on import (e.g. an unknown category). */
  warnings: string[];
  value: {
    name: string;
    startDate: string;
    endDate: string;
    hours: { open: string; close: string } | null;
    venueName: string | null;
    address: string | null;
    city: string;
    state: StateCode;
    zip: string | null;
    description: string | null;
    categories: string[];
    ticketPriceMin: number | null;
    ticketPriceMax: number | null;
    applicationUrl: string | null;
    applicationDeadline: string | null;
    vendorFeeMin: number | null;
    vendorFeeMax: number | null;
    eventUrl: string | null;
    imageUrl: string | null;
  } | null;
}

export const MAX_IMPORT_ROWS = 250;
const MAX_DAYS = 31;

export function parseRows(table: string[][]): {
  rows: ImportRow[];
  headerErrors: string[];
  unknownColumns: string[];
} {
  if (!table.length) return { rows: [], headerErrors: ["The file is empty."], unknownColumns: [] };
  const { index, unknown, missingRequired } = mapHeaders(table[0]);
  const headerErrors = missingRequired.length
    ? [
        `Missing required column${missingRequired.length > 1 ? "s" : ""}: ${missingRequired.join(", ")}. Download the template for the column names.`,
      ]
    : [];
  const body = table.slice(1);
  if (body.length > MAX_IMPORT_ROWS)
    headerErrors.push(
      `The file has ${body.length} rows; the limit is ${MAX_IMPORT_ROWS} per file. Split it into smaller files.`
    );
  if (headerErrors.length) return { rows: [], headerErrors, unknownColumns: unknown };

  const rows = body.map((cells, i): ImportRow => {
    const raw: Partial<Record<ImportField, string>> = {};
    for (const c of TEMPLATE_COLUMNS) {
      const at = index[c.key];
      const v = at === undefined ? "" : (cells[at] ?? "").trim();
      if (v) raw[c.key] = v;
    }
    const errors: string[] = [];
    const fieldErrors: ImportRow["fieldErrors"] = [];
    const fail = (field: ImportField | null, message: string) => {
      errors.push(message);
      fieldErrors.push({ field, message });
    };
    const get = (k: ImportField) => raw[k] ?? "";
    for (const c of TEMPLATE_COLUMNS)
      if (c.required && !get(c.key)) fail(c.key, `${c.header} is required.`);

    const startDate = get("start_date") ? parseDateCell(get("start_date")) : null;
    if (get("start_date") && !startDate)
      fail(
        "start_date",
        `Start date "${get("start_date")}" isn't a date we can read (use 2027-10-02 or 10/2/2027).`
      );
    const endDate = get("end_date") ? parseDateCell(get("end_date")) : startDate;
    if (get("end_date") && !endDate)
      fail("end_date", `End date "${get("end_date")}" isn't a date we can read.`);
    if (startDate && endDate && endDate < startDate)
      fail("end_date", "End date is before the start date.");
    if (startDate && endDate && endDate >= startDate) {
      const days = (Date.parse(endDate) - Date.parse(startDate)) / 86_400_000 + 1;
      if (days > MAX_DAYS)
        fail("end_date", `The event runs ${days} days; the limit for one row is ${MAX_DAYS}.`);
    }
    const hours = get("daily_hours") ? parseHoursCell(get("daily_hours")) : null;
    if (get("daily_hours") && !hours)
      fail("daily_hours", `Daily hours "${get("daily_hours")}" can't be read (use 9am-4pm).`);
    const state = get("state") ? parseState(get("state")) : null;
    if (get("state") && !state)
      fail("state", `State "${get("state")}" isn't one of ME, NH, VT, MA, CT, RI.`);
    const admission = parseAdmission(get("admission"));
    if (!admission)
      fail("admission", `Admission "${get("admission")}" can't be read (use Free, $5 or $5-$10).`);
    const feeMin = parseMoney(get("booth_fee_min"));
    const feeMax = parseMoney(get("booth_fee_max"));
    if (Number.isNaN(feeMin))
      fail("booth_fee_min", `Booth fee min "${get("booth_fee_min")}" isn't an amount.`);
    if (Number.isNaN(feeMax))
      fail("booth_fee_max", `Booth fee max "${get("booth_fee_max")}" isn't an amount.`);
    if (
      feeMin !== null &&
      feeMax !== null &&
      !Number.isNaN(feeMin) &&
      !Number.isNaN(feeMax) &&
      feeMax < feeMin
    )
      fail("booth_fee_max", "Booth fee max is less than the min.");
    const deadline = get("application_deadline")
      ? parseDateCell(get("application_deadline"))
      : null;
    if (get("application_deadline") && !deadline)
      fail(
        "application_deadline",
        `Application deadline "${get("application_deadline")}" isn't a date.`
      );
    for (const k of ["vendor_application_url", "event_url", "image_url"] as const) {
      if (get(k) && !isHttpUrl(get(k)))
        fail(
          k,
          `${TEMPLATE_COLUMNS.find((c) => c.key === k)!.header} must start with https:// or http://.`
        );
    }
    if (get("name").length > 200) fail("name", "Event name is longer than 200 characters.");
    // OPE-1058 — the one shared allow-list (partitionEventCategories). A sheet's
    // "craft fair" is matched to the canonical "Craft Fair"; a value we do not
    // use is dropped with a warning, never stored and never a blocking error.
    const categories = partitionEventCategories(
      get("categories")
        .split(/[;,|]/)
        .map((c) => c.trim())
        .filter(Boolean)
        .map((c) => EVENT_CATEGORIES.find((k) => k.toLowerCase() === c.toLowerCase()) ?? c)
    );
    const warnings = categories.dropped.length
      ? [
          `Categor${categories.dropped.length > 1 ? "ies" : "y"} not used on our site, left off: ${categories.dropped.join(", ")}.`,
        ]
      : [];
    if (get("description").length > 5000)
      fail("description", "Description is longer than 5,000 characters.");

    const value: ImportRow["value"] = errors.length
      ? null
      : {
          name: get("name"),
          startDate: startDate!,
          endDate: endDate!,
          hours,
          venueName: get("venue_name") || null,
          address: get("address") || null,
          city: get("city"),
          state: state!,
          zip: get("zip") || null,
          description: get("description") || null,
          categories: categories.kept,
          ticketPriceMin: admission!.min,
          ticketPriceMax: admission!.max,
          applicationUrl: get("vendor_application_url") || null,
          applicationDeadline: deadline,
          vendorFeeMin: feeMin,
          vendorFeeMax: feeMax,
          eventUrl: get("event_url") || null,
          imageUrl: get("image_url") || null,
        };
    return { rowNumber: i + 2, raw, errors, fieldErrors, warnings, value };
  });

  // The same show twice in one file: the later row is the error.
  const seen = new Map<string, number>();
  for (const r of rows) {
    if (!r.value) continue;
    const k = `${createSlug(r.value.name)}|${r.value.startDate}`;
    const first = seen.get(k);
    if (first !== undefined) {
      r.errors.push(`Same event and start date as row ${first}.`);
      r.fieldErrors.push({ field: null, message: `Same event and start date as row ${first}.` });
      r.value = null;
    } else seen.set(k, r.rowNumber);
  }
  return { rows, headerErrors: [], unknownColumns: unknown };
}

/** Each day from start to end with the row's hours (none when the sheet gives none). */
export function rowDays(
  v: NonNullable<ImportRow["value"]>
): Array<{ date: string; openTime: string | null; closeTime: string | null }> {
  const out: Array<{ date: string; openTime: string | null; closeTime: string | null }> = [];
  for (let t = Date.parse(v.startDate); t <= Date.parse(v.endDate); t += 86_400_000) {
    out.push({
      date: new Date(t).toISOString().slice(0, 10),
      openTime: v.hours?.open ?? null,
      closeTime: v.hours?.close ?? null,
    });
  }
  return out;
}
