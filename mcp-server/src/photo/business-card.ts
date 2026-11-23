/**
 * OPE-1705 — a vendor's BUSINESS CARD, photographed in Snap or emailed to photos@.
 *
 * The main classifier (`vision.ts`) only decides that a photo IS a card
 * (`kind: "business_card"`). The fields are read here, by a SECOND, focused
 * vision call — the same shape as the OPE-240 presence check. Not one bigger
 * prompt: vision.ts measured that a fuller prompt broke JSON on 2 of 3 runs on
 * this 11B model, and a card carries ten fields.
 *
 * ── What a card may write (John's ruling (a), 2026-11-22) ───────────────────
 *  - IDENTITY fields — website, social_links, address, city, state, zip — fill a
 *    matched vendor's BLANK columns directly (when PHOTO_AUTOWRITE_ENABLED is on
 *    and the field read at 1.0). A disagreement with a non-blank value is a
 *    CONFLICT: staged, never overwritten.
 *  - CONTACT fields — contact_email, contact_phone, contact_name — are ALWAYS
 *    staged as pending `vendor_enrichment_candidates`. The public vendor page
 *    renders all three (and the JSON-LD emits two), so nothing a card says about
 *    a person goes public until a reviewer approves it.
 *
 * ── Never invent ──────────────────────────────────────────────────────────
 * Every field passes a SHAPE check after the model: an email must look like one,
 * a phone must be 10 NANP digits, a state two letters, a ZIP 5 or 9 digits. A
 * value that fails is null — missing, not guessed. A social handle printed
 * without its platform ("@shopname" beside an icon the model cannot name) is
 * dropped: mapping it to a network would be a guess.
 *
 * ── The image ─────────────────────────────────────────────────────────────
 * Never a hero, logo or gallery photo. The card path has no image write at all,
 * and card proposals use their own audit action (`vendor.card_proposed`) so the
 * booth approve tails — which post the photo — never select them.
 */
import { and, eq, isNull } from "drizzle-orm";
import { extractJsonObject } from "../model-json.js";
import { VISION_MODEL, cleanWebsite, type VisionAi } from "./vision.js";
import { isGenericSignName } from "./sign-words.js";
import { vendors, vendorEnrichmentCandidates } from "../schema.js";
import type { Db } from "../db.js";

/** Same 1.0 bar as the booth lane (OPE-240) — a card field is a public claim. */
export const CARD_FIELD_CONFIDENCE = 1.0;

export const CARD_PROMPT = `This photo shows a BUSINESS CARD. Read it. Report ONLY text you can clearly read on the card.

Rules:
1. Copy each value EXACTLY as printed. Never guess a letter or digit. If a field is not printed, or any part of it is not clearly legible, use null.
2. business_name: the business, not the person.
3. contact_name: a person's name, if printed.
4. social: full links or "platform: handle" pairs only, e.g. "instagram.com/shopname". A bare @handle with no platform word: leave it out.
5. Give each field a confidence 0.0-1.0. Use 1.0 ONLY when every character is sharp.

Reply with ONLY a JSON object:
{"business_name":{"value":string|null,"confidence":number},"contact_name":{...},"phone":{...},"email":{...},"website":{...},"social":{"value":[string],"confidence":number},"street":{...},"city":{...},"state":{...},"zip":{...}}`;

const FIELD = {
  type: "object",
  properties: { value: { type: ["string", "null"] }, confidence: { type: "number" } },
  required: ["value", "confidence"],
} as const;

export const CARD_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    type: "object",
    properties: {
      business_name: FIELD,
      contact_name: FIELD,
      phone: FIELD,
      email: FIELD,
      website: FIELD,
      social: {
        type: "object",
        properties: {
          value: { type: "array", items: { type: "string" }, maxItems: 6 },
          confidence: { type: "number" },
        },
        required: ["value", "confidence"],
      },
      street: FIELD,
      city: FIELD,
      state: FIELD,
      zip: FIELD,
    },
    required: [
      "business_name",
      "contact_name",
      "phone",
      "email",
      "website",
      "social",
      "street",
      "city",
      "state",
      "zip",
    ],
  },
} as const;

export interface CardField<T = string> {
  value: T;
  confidence: number;
}

/** A card as read. A field is absent when it was not printed, not legible, or failed its shape check. */
export interface CardReading {
  businessName?: CardField;
  contactName?: CardField;
  /** Normalised `(207) 555-0123`. */
  phone?: CardField;
  /** Lower-cased. */
  email?: CardField;
  website?: CardField;
  /** network → URL, the `vendors.social_links` shape. */
  social?: CardField<Record<string, string>>;
  street?: CardField;
  city?: CardField;
  /** Two-letter, upper-cased. */
  state?: CardField;
  zip?: CardField;
  /** Set when the reply could not be read at all. */
  failureReason?: string;
}

function conf(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return Math.max(0, Math.min(1, v));
}

function str(v: unknown, max = 200): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/\s+/g, " ");
  if (!s || /^(null|none|n\/a|unknown)$/i.test(s)) return null;
  return s.length > max ? null : s;
}

const EMAIL_RE = /^[a-z0-9._%+-]+@([a-z0-9-]+\.)+[a-z]{2,}$/i;
const STATE_RE = /^[A-Z]{2}$/;
const ZIP_RE = /^\d{5}(-\d{4})?$/;

/** 10 NANP digits (an optional leading 1), else null. Extensions are dropped, not kept half-read. */
export function normalizePhone(raw: string): string | null {
  const main = raw.split(/\b(?:ext|x)\.?\s*\d+$/i)[0];
  let d = main.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  if (d.length !== 10 || /^[01]/.test(d)) return null;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

const SOCIAL_HOSTS: Array<[RegExp, string]> = [
  [/(^|\.)instagram\.com$/i, "instagram"],
  [/(^|\.)facebook\.com$|(^|\.)fb\.com$/i, "facebook"],
  [/(^|\.)tiktok\.com$/i, "tiktok"],
  [/(^|\.)etsy\.com$/i, "etsy"],
  [/(^|\.)pinterest\.com$/i, "pinterest"],
  [/(^|\.)youtube\.com$/i, "youtube"],
  [/(^|\.)(x|twitter)\.com$/i, "x"],
];
const SOCIAL_PREFIX: Array<[RegExp, string, string]> = [
  [
    /^(?:ig|insta|instagram)\s*[:\-]\s*@?([a-z0-9._]{2,30})$/i,
    "instagram",
    "https://instagram.com/",
  ],
  [/^(?:fb|facebook)\s*[:\-]\s*@?([a-z0-9.\-]{2,50})$/i, "facebook", "https://facebook.com/"],
  [/^tiktok\s*[:\-]\s*@?([a-z0-9._]{2,30})$/i, "tiktok", "https://tiktok.com/@"],
  [/^etsy\s*[:\-]\s*@?([a-z0-9]{2,40})$/i, "etsy", "https://etsy.com/shop/"],
];

/** One printed social entry → [network, url], or null when the platform cannot be named. */
export function parseSocialEntry(raw: string): [string, string] | null {
  const s = raw.trim();
  for (const [re, net, base] of SOCIAL_PREFIX) {
    const m = s.match(re);
    if (m) return [net, `${base}${m[1].replace(/^@/, "")}`];
  }
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    const path = u.pathname.replace(/\/+$/, "");
    if (!path || path === "/") return null;
    for (const [re, net] of SOCIAL_HOSTS) {
      if (re.test(u.hostname)) return [net, `https://${u.hostname.replace(/^www\./, "")}${path}`];
    }
  } catch {
    /* not a URL */
  }
  return null;
}

/**
 * Parse the card reply. Pure and total: anything unreadable is simply absent,
 * and a reply with no object at all carries `failureReason` (→ the card stages).
 */
export function parseCardReply(raw: unknown): CardReading {
  const resp = (raw as { response?: unknown })?.response ?? raw;
  const obj: unknown = typeof resp === "string" ? extractJsonObject(resp) : resp;
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { failureReason: `card-reply-unreadable shape=${typeof resp}` };
  }
  const o = obj as Record<string, { value?: unknown; confidence?: unknown } | undefined>;
  const out: CardReading = {};
  const take = (k: string, check: (s: string) => string | null): CardField | undefined => {
    const f = o[k];
    const s = str(f?.value);
    const v = s === null ? null : check(s);
    return v === null ? undefined : { value: v, confidence: conf(f?.confidence) };
  };

  out.businessName = take("business_name", (s) => s);
  out.contactName = take("contact_name", (s) => (/\d/.test(s) || s.length > 80 ? null : s));
  out.phone = take("phone", normalizePhone);
  out.email = take("email", (s) => (EMAIL_RE.test(s) ? s.toLowerCase() : null));
  out.website = take("website", (s) => cleanWebsite(s));
  out.street = take("street", (s) => (/\d/.test(s) ? s : null));
  out.city = take("city", (s) => (/\d/.test(s) ? null : s));
  out.state = take("state", (s) => (STATE_RE.test(s.toUpperCase()) ? s.toUpperCase() : null));
  out.zip = take("zip", (s) => (ZIP_RE.test(s) ? s : null));

  const soc = o.social as { value?: unknown; confidence?: unknown } | undefined;
  if (Array.isArray(soc?.value)) {
    const links: Record<string, string> = {};
    for (const e of soc.value) {
      const p = typeof e === "string" ? parseSocialEntry(e) : null;
      if (p && !links[p[0]]) links[p[0]] = p[1];
    }
    if (Object.keys(links).length) out.social = { value: links, confidence: conf(soc.confidence) };
  }

  for (const k of Object.keys(out) as Array<keyof CardReading>) {
    if (out[k] === undefined) delete out[k];
  }
  return out;
}

/** Read one card's fields. Never throws: a failure is a reading with `failureReason`. */
export async function readBusinessCard(ai: VisionAi, bytes: Uint8Array): Promise<CardReading> {
  const image = Array.from(bytes);
  let last: CardReading = { failureReason: "card read not attempted" };
  // One retry, the identifyBooth rule: the model emits malformed JSON intermittently.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await ai.run(VISION_MODEL, {
        image,
        prompt: CARD_PROMPT,
        max_tokens: 512,
        response_format: CARD_RESPONSE_FORMAT as never,
      });
      last = parseCardReply(raw);
      if (!last.failureReason) return last;
    } catch (e) {
      last = { failureReason: `card-ai-run-threw: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  return last;
}

// ─── What the card does to a vendor ─────────────────────────────────────────

/** Vendor columns a card can speak to. */
export type CardColumn =
  | "website"
  | "social_links"
  | "address"
  | "city"
  | "state"
  | "zip"
  | "contact_email"
  | "contact_phone"
  | "contact_name";

/** Ruling (a): these never write directly — they always stage. */
export const CARD_CONTACT_COLUMNS: ReadonlySet<CardColumn> = new Set([
  "contact_email",
  "contact_phone",
  "contact_name",
]);

export interface VendorCardSnapshot {
  website: string | null;
  socialLinks: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  contactName: string | null;
}

export type CardFieldAction =
  /** Blank on the vendor, identity field, read at 1.0, auto-write on → written. */
  | "write"
  /** Staged as a pending enrichment candidate (contact field, auto-write off, or below the bar). */
  | "stage"
  /** The vendor already has a DIFFERENT value — staged, flagged, never overwritten. */
  | "conflict"
  /** The vendor already has this value. Nothing to do. */
  | "same";

export interface CardFieldPlan {
  column: CardColumn;
  value: string;
  confidence: number;
  current: string | null;
  action: CardFieldAction;
}

function blank(v: string | null | undefined): boolean {
  return v === null || v === undefined || v.trim() === "";
}

function canon(column: CardColumn, v: string): string {
  if (column === "website") {
    return v
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/+$/, "");
  }
  if (column === "contact_phone") return v.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return v.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Decide, per field, what a card does to one vendor. Pure — the whole
 * write-vs-stage-vs-conflict judgment lives here so it can be tested exhaustively.
 *
 * `social_links` is merged per NETWORK: a card's instagram fills a blank
 * instagram even when the vendor has a facebook. The merged JSON is the value.
 */
export function planCardFields(
  card: CardReading,
  vendor: VendorCardSnapshot,
  opts: { autoWrite: boolean }
): CardFieldPlan[] {
  const plans: CardFieldPlan[] = [];
  const add = (column: CardColumn, f: CardField | undefined, current: string | null) => {
    if (!f) return;
    let action: CardFieldAction;
    if (!blank(current)) {
      action = canon(column, current as string) === canon(column, f.value) ? "same" : "conflict";
    } else if (
      opts.autoWrite &&
      !CARD_CONTACT_COLUMNS.has(column) &&
      f.confidence >= CARD_FIELD_CONFIDENCE
    ) {
      action = "write";
    } else {
      action = "stage";
    }
    plans.push({ column, value: f.value, confidence: f.confidence, current, action });
  };

  add("website", card.website, vendor.website);
  add("address", card.street, vendor.address);
  add("city", card.city, vendor.city);
  add("state", card.state, vendor.state);
  add("zip", card.zip, vendor.zip);
  add("contact_email", card.email, vendor.contactEmail);
  add("contact_phone", card.phone, vendor.contactPhone);
  add("contact_name", card.contactName, vendor.contactName);

  if (card.social) {
    let existing: Record<string, string> = {};
    try {
      const p = vendor.socialLinks ? JSON.parse(vendor.socialLinks) : {};
      if (p && typeof p === "object" && !Array.isArray(p)) existing = p;
    } catch {
      existing = {};
    }
    const fresh = Object.entries(card.social.value).filter(([net]) => blank(existing[net]));
    const clash = Object.entries(card.social.value).some(
      ([net, url]) =>
        !blank(existing[net]) && canon("website", existing[net]) !== canon("website", url)
    );
    if (fresh.length) {
      const merged = JSON.stringify({ ...existing, ...Object.fromEntries(fresh) });
      const writable = opts.autoWrite && card.social.confidence >= CARD_FIELD_CONFIDENCE;
      plans.push({
        column: "social_links",
        value: merged,
        confidence: card.social.confidence,
        current: vendor.socialLinks,
        action: writable ? "write" : "stage",
      });
    } else if (clash) {
      plans.push({
        column: "social_links",
        value: JSON.stringify(card.social.value),
        confidence: card.social.confidence,
        current: vendor.socialLinks,
        action: "conflict",
      });
    }
  }
  return plans;
}

/** Why a card staged instead of matching a vendor. Closed vocabulary, like StageKind. */
export type CardStageKind =
  | "card_unreadable"
  | "card_name_unreadable"
  | "card_name_generic"
  | "card_domain_ambiguous"
  | "card_match_check_failed"
  /** Readable, but no existing vendor matches — the "Add as vendor" lane decides (OPE-1705 slice 3). */
  | "card_unmatched";

/** Is the business name good enough to match or create on? Null = yes. */
export function cardNameProblem(card: CardReading): CardStageKind | null {
  if (card.failureReason && !card.businessName) return "card_unreadable";
  const n = card.businessName;
  if (!n || n.confidence < CARD_FIELD_CONFIDENCE) return "card_name_unreadable";
  if (isGenericSignName(n.value)) return "card_name_generic";
  return null;
}

/** The domains a card offers for an OPE-1694 match, best first: its website, then its email's host. */
export function cardDomainCandidates(card: CardReading): string[] {
  const out: string[] = [];
  if (card.website) out.push(card.website.value);
  if (card.email) out.push(card.email.value.split("@")[1]);
  return out;
}

// ─── The DB tail ────────────────────────────────────────────────────────────

/** `vendor_enrichment_candidates.extraction_method` for a card-sourced row. */
export const CARD_EXTRACTION_METHOD = "business_card";

const COLUMN_TO_PROP: Record<CardColumn, keyof VendorCardSnapshot> = {
  website: "website",
  social_links: "socialLinks",
  address: "address",
  city: "city",
  state: "state",
  zip: "zip",
  contact_email: "contactEmail",
  contact_phone: "contactPhone",
  contact_name: "contactName",
};

export interface CardApplyResult {
  written: CardColumn[];
  staged: CardColumn[];
  conflicts: CardColumn[];
  /** A staged field that already had an OPEN candidate for this vendor (partial unique index). */
  alreadyPending: CardColumn[];
}

/**
 * Apply a plan to one vendor. Writes are a single UPDATE guarded column-by-column
 * on IS NULL, so a value that landed between the read and the write is never
 * overwritten — that column simply does not change. Staged and conflict fields
 * become pending `vendor_enrichment_candidates` (flags record which), at most one
 * open row per (vendor, field) as the table's partial unique index requires.
 */
export async function applyCardPlan(
  db: Db,
  vendorId: string,
  plans: CardFieldPlan[],
  source: { sourceRef: string; jobRunId: string },
  now: Date = new Date()
): Promise<CardApplyResult> {
  const res: CardApplyResult = { written: [], staged: [], conflicts: [], alreadyPending: [] };
  for (const p of plans.filter((x) => x.action === "write")) {
    const prop = COLUMN_TO_PROP[p.column];
    // One column per UPDATE so the IS NULL guard is per column, and a lost race
    // shows as 0 changes rather than a silent partial overwrite.
    const r = await db
      .update(vendors)
      .set({ [prop]: p.value })
      .where(and(eq(vendors.id, vendorId), isNull(vendors[prop])))
      .returning({ id: vendors.id });
    if (r.length > 0) res.written.push(p.column);
    else {
      // Filled by someone else since the read: keep the card's value as a candidate instead.
      p.action = "conflict";
    }
  }

  for (const p of plans.filter((x) => x.action === "stage" || x.action === "conflict")) {
    const flags = ["business_card", ...(p.action === "conflict" ? ["card_conflict"] : [])];
    const r = await db
      .insert(vendorEnrichmentCandidates)
      .values({
        vendorId,
        jobRunId: source.jobRunId,
        proposedField: p.column,
        currentValue: p.current,
        proposedValue: p.value,
        sourceUrl: source.sourceRef,
        extractionMethod: CARD_EXTRACTION_METHOD,
        fetchMethod: null,
        confidence: p.confidence,
        flags: JSON.stringify(flags),
        createdAt: now,
        decision: "pending",
      })
      .onConflictDoNothing()
      .returning({ id: vendorEnrichmentCandidates.id });
    if (r.length === 0) res.alreadyPending.push(p.column);
    else if (p.action === "conflict") res.conflicts.push(p.column);
    else res.staged.push(p.column);
  }
  return res;
}

/** OPE-1705 — rebuild a CardReading from the `card` object the pipeline recorded. */
export function cardFromPayload(raw: unknown): CardReading {
  const out: Record<string, unknown> = {};
  if (raw && typeof raw === "object") {
    for (const [k, f] of Object.entries(raw as Record<string, unknown>)) {
      const field = f as { value?: unknown; confidence?: unknown } | null;
      if (field && field.value !== undefined && field.value !== null) {
        out[k] = {
          value: field.value,
          confidence: typeof field.confidence === "number" ? field.confidence : 0,
        };
      }
    }
  }
  return out as CardReading;
}
