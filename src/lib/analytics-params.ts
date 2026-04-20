/**
 * Shared date-range resolution for analytics endpoints.
 * Accepts either explicit startDate/endDate or a preset name and returns
 * absolute dates (inclusive) plus the preceding comparison period.
 *
 * All dates are interpreted in the GA4 property's configured timezone
 * (America/New_York for MMATF) — we deliberately compute in UTC for
 * determinism and let GA4 apply its own TZ at query time.
 */

export type DateRangePreset =
  | "last_7d"
  | "last_28d"
  | "last_30d"
  | "last_90d"
  | "last_365d"
  | "mtd"
  | "ytd"
  | "prev_7d"
  | "prev_28d";

export const DATE_RANGE_PRESETS: DateRangePreset[] = [
  "last_7d",
  "last_28d",
  "last_30d",
  "last_90d",
  "last_365d",
  "mtd",
  "ytd",
  "prev_7d",
  "prev_28d",
];

export type DateRangeInput = {
  startDate?: string;
  endDate?: string;
  preset?: DateRangePreset;
};

export type ResolvedDateRange = {
  startDate: string; // ISO YYYY-MM-DD, inclusive
  endDate: string; // ISO YYYY-MM-DD, inclusive
  previousStartDate: string;
  previousEndDate: string;
  days: number;
  label?: DateRangePreset;
};

export class DateRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DateRangeError";
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function yesterdayIso(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function diffDays(startIso: string, endIso: string): number {
  const s = new Date(`${startIso}T00:00:00Z`).getTime();
  const e = new Date(`${endIso}T00:00:00Z`).getTime();
  return Math.round((e - s) / (24 * 60 * 60 * 1000)) + 1;
}

function resolvePreset(preset: DateRangePreset): { startDate: string; endDate: string } {
  const today = new Date();
  const yesterday = yesterdayIso();
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();

  switch (preset) {
    case "last_7d":
      return { startDate: addDays(yesterday, -6), endDate: yesterday };
    case "last_28d":
      return { startDate: addDays(yesterday, -27), endDate: yesterday };
    case "last_30d":
      return { startDate: addDays(yesterday, -29), endDate: yesterday };
    case "last_90d":
      return { startDate: addDays(yesterday, -89), endDate: yesterday };
    case "last_365d":
      return { startDate: addDays(yesterday, -364), endDate: yesterday };
    case "mtd":
      return {
        startDate: new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10),
        endDate: yesterday,
      };
    case "ytd":
      return {
        startDate: new Date(Date.UTC(y, 0, 1)).toISOString().slice(0, 10),
        endDate: yesterday,
      };
    case "prev_7d":
      return { startDate: addDays(yesterday, -13), endDate: addDays(yesterday, -7) };
    case "prev_28d":
      return { startDate: addDays(yesterday, -55), endDate: addDays(yesterday, -28) };
  }
}

export function resolveDateRange(
  input: DateRangeInput | undefined,
  options: { defaultPreset: DateRangePreset }
): ResolvedDateRange {
  let startDate: string;
  let endDate: string;
  let label: DateRangePreset | undefined;

  if (input?.startDate || input?.endDate) {
    if (input.preset) {
      throw new DateRangeError("Specify either startDate/endDate or preset, not both.");
    }
    if (!input.startDate || !input.endDate) {
      throw new DateRangeError("Both startDate and endDate must be supplied together.");
    }
    if (!ISO_DATE.test(input.startDate) || !ISO_DATE.test(input.endDate)) {
      throw new DateRangeError("Dates must be ISO format YYYY-MM-DD.");
    }
    startDate = input.startDate;
    endDate = input.endDate;
  } else {
    const preset = input?.preset ?? options.defaultPreset;
    if (!DATE_RANGE_PRESETS.includes(preset)) {
      throw new DateRangeError(`Unknown preset '${preset}'.`);
    }
    const resolved = resolvePreset(preset);
    startDate = resolved.startDate;
    endDate = resolved.endDate;
    label = preset;
  }

  if (startDate > endDate) {
    throw new DateRangeError("startDate must be on or before endDate.");
  }
  const today = todayIso();
  if (startDate > today) {
    throw new DateRangeError("startDate cannot be in the future.");
  }

  const days = diffDays(startDate, endDate);
  const previousEndDate = addDays(startDate, -1);
  const previousStartDate = addDays(previousEndDate, -(days - 1));

  return { startDate, endDate, previousStartDate, previousEndDate, days, label };
}

/**
 * Parse a URLSearchParams-ish object into a DateRangeInput and the other
 * shared optional params (pathPrefix, rowLimit, orderBy, comparePrev).
 * Returns undefined for any field not present.
 */
export type CommonAnalyticsParams = {
  dateRange?: DateRangeInput;
  comparePreviousPeriod?: boolean;
  pathPrefix?: string;
  rowLimit?: number;
  orderBy?: string;
  minViews?: number;
  minImpressions?: number;
  refresh?: boolean;
};

export function parseAnalyticsParams(searchParams: URLSearchParams): CommonAnalyticsParams {
  const out: CommonAnalyticsParams = {};

  const startDate = searchParams.get("startDate") ?? undefined;
  const endDate = searchParams.get("endDate") ?? undefined;
  const preset = searchParams.get("preset") ?? undefined;
  if (startDate || endDate || preset) {
    out.dateRange = {
      startDate,
      endDate,
      preset: preset as DateRangePreset | undefined,
    };
  }

  const cmp = searchParams.get("comparePreviousPeriod");
  if (cmp !== null) out.comparePreviousPeriod = cmp === "true" || cmp === "1";

  const prefix = searchParams.get("pathPrefix");
  if (prefix) out.pathPrefix = prefix;

  const rowLimit = searchParams.get("rowLimit");
  if (rowLimit) {
    const n = Number(rowLimit);
    if (Number.isFinite(n) && n > 0) out.rowLimit = Math.min(Math.floor(n), 500);
  }

  const orderBy = searchParams.get("orderBy");
  if (orderBy) out.orderBy = orderBy;

  const minViews = searchParams.get("minViews");
  if (minViews) {
    const n = Number(minViews);
    if (Number.isFinite(n) && n >= 0) out.minViews = Math.floor(n);
  }

  const minImpressions = searchParams.get("minImpressions");
  if (minImpressions) {
    const n = Number(minImpressions);
    if (Number.isFinite(n) && n >= 0) out.minImpressions = Math.floor(n);
  }

  if (searchParams.get("refresh") === "1" || searchParams.get("refresh") === "true") {
    out.refresh = true;
  }

  return out;
}
