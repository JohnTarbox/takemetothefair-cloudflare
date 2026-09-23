/**
 * OPE-940 (John's ruling "1+3", 2026-09-23) — let an unattended runner READ a
 * poster.
 *
 * The daily sweep's first rule is "read the actual poster, don't trust text
 * extraction", and the scheduled runner had no way to see an image: web_fetch
 * returns a poster JPEG as its filename, and the browser pane needs an
 * interactive approval nobody is there to give. Eddington Historical Society
 * publishes its whole events page as two <img> tags — hours and price exist
 * only inside the JPEG.
 *
 * READ-ONLY by design. OPE-969 measured confident misreads from this same
 * model, so a reading is a LEAD to cite (with the image URL), never a value to
 * write unreviewed. Nothing here touches the database.
 */
import { VISION_MODEL } from "./vision.js";

export const POSTER_PROMPT = `You are looking at an EVENT POSTER or flyer (a fair, festival, bazaar, market, show).

Transcribe what is PRINTED. Never infer, never guess, never fill a field from general knowledge.

Rules — follow exactly:
1. event_name: the event's name as printed, or null.
2. dates: every date printed, each as written (e.g. "Saturday, September 12, 2026"). [] if none.
3. hours: the times as printed (e.g. "10am - 2pm"), or null.
4. price: admission/entry price as printed (e.g. "$5, under 18 free", "Free admission"), or null.
5. location: the place as printed (e.g. "Town Office Lawn"), or null.
6. raw_text: all legible text, top to bottom, lines separated by " | ".
7. confidence: 0.0-1.0. LOW (<0.5) if the text is small, blurry, stylised or cut off.

Reply with ONLY a JSON object, no prose, no markdown fence:
{"event_name":string|null,"dates":[string],"hours":string|null,"price":string|null,"location":string|null,"raw_text":string,"confidence":number}`;

export const POSTER_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    type: "object",
    properties: {
      event_name: { type: ["string", "null"] },
      dates: { type: "array", items: { type: "string" } },
      hours: { type: ["string", "null"] },
      price: { type: ["string", "null"] },
      location: { type: ["string", "null"] },
      raw_text: { type: "string" },
      confidence: { type: "number" },
    },
    required: ["event_name", "dates", "hours", "price", "location", "raw_text", "confidence"],
  },
} as const;

/** Per-call cap: one image, at most this many bytes (phone posters run 3–8 MB). */
export const POSTER_MAX_BYTES = 10 * 1024 * 1024;

export interface PosterReading {
  event_name: string | null;
  dates: string[];
  hours: string | null;
  price: string | null;
  location: string | null;
  raw_text: string;
  confidence: number;
  /** Set when the model gave nothing usable; every field above is then empty. */
  failure_reason: string | null;
}

export interface PosterAi {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

const EMPTY: Omit<PosterReading, "failure_reason"> = {
  event_name: null,
  dates: [],
  hours: null,
  price: null,
  location: null,
  raw_text: "",
  confidence: 0,
};

function str(v: unknown, max = 300): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

/** Pure + total: whatever the model returned becomes a PosterReading. */
export function parsePosterReply(raw: unknown): PosterReading {
  let obj: unknown = raw;
  if (raw && typeof raw === "object" && "response" in raw)
    obj = (raw as { response: unknown }).response;
  if (typeof obj === "string") {
    const s = obj.trim();
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start === -1 || end <= start) return { ...EMPTY, failure_reason: "no-json-in-reply" };
    try {
      obj = JSON.parse(s.slice(start, end + 1));
    } catch {
      return { ...EMPTY, failure_reason: "unparseable-json" };
    }
  }
  if (!obj || typeof obj !== "object") return { ...EMPTY, failure_reason: "reply-not-an-object" };
  const o = obj as Record<string, unknown>;
  const conf = typeof o.confidence === "number" && Number.isFinite(o.confidence) ? o.confidence : 0;
  return {
    event_name: str(o.event_name),
    dates: Array.isArray(o.dates)
      ? o.dates.map((d) => str(d, 80)).filter((d): d is string => !!d)
      : [],
    hours: str(o.hours, 120),
    price: str(o.price, 160),
    location: str(o.location, 200),
    raw_text: str(o.raw_text, 4000) ?? "",
    confidence: Math.max(0, Math.min(1, conf)),
    failure_reason: null,
  };
}

/** Run the vision model over one poster. Never throws. */
export async function readPoster(ai: PosterAi, bytes: Uint8Array): Promise<PosterReading> {
  try {
    const raw = await ai.run(VISION_MODEL, {
      image: Array.from(bytes),
      prompt: POSTER_PROMPT,
      max_tokens: 768,
      response_format: POSTER_RESPONSE_FORMAT,
    });
    return parsePosterReply(raw);
  } catch (e) {
    return {
      ...EMPTY,
      failure_reason: `ai-run-threw: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Does any printed date name this ISO day (month word + day number)? */
export function posterNamesDay(dates: string[], isoDate: string): boolean {
  const [, m, d] = isoDate.split("-").map(Number);
  if (!m || !d) return false;
  const mon = MONTHS[m - 1];
  const re = new RegExp(`\\b${mon}[a-z]*\\.?\\s+0?${d}(?!\\d)|\\b0?${m}[/-]0?${d}(?!\\d)`, "i");
  return dates.some((s) => re.test(s));
}

/**
 * Where the poster and the stored row disagree. The POSTER is reported as the
 * value to cite — the row is what the runner checks against it, and a
 * disagreement is exactly the case the sweep rule exists for.
 */
export function posterDisagreements(
  reading: PosterReading,
  row: { start_date: string | null; ticket_price_min: number | null } | null
): string[] {
  if (!row || reading.failure_reason) return [];
  const out: string[] = [];
  if (
    row.start_date &&
    reading.dates.length > 0 &&
    !posterNamesDay(reading.dates, row.start_date)
  ) {
    out.push(`start_date: row says ${row.start_date}; poster prints ${reading.dates.join(" / ")}`);
  }
  if (reading.price) {
    const posterFree = /\bfree\b/i.test(reading.price) && !/\$\s*\d/.test(reading.price);
    if (posterFree && row.ticket_price_min !== null && row.ticket_price_min > 0) {
      out.push(`price: row says $${row.ticket_price_min}; poster prints "${reading.price}"`);
    }
    const m = reading.price.match(/\$\s*(\d+(?:\.\d{1,2})?)/);
    if (
      m &&
      row.ticket_price_min !== null &&
      Number(m[1]) !== row.ticket_price_min &&
      !posterFree
    ) {
      out.push(`price: row says $${row.ticket_price_min}; poster prints "${reading.price}"`);
    }
  }
  return out;
}
