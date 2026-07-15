/**
 * OPE-204 — vision identification of a booth photo.
 *
 * Given the bytes of one on-site photo, decide whether it shows a VENDOR BOOTH
 * (and if so, who) or is a GENERAL fair scene. The vendor name comes from
 * legible signage — banners, table signs, product displays.
 *
 * ── Why a real vision model and not OCR ───────────────────────────────────
 * The repo already has an image path (`env.AI.toMarkdown`, OPE-68) but it is
 * managed image→markdown OCR: you cannot ask it a question. OCR is also
 * structurally unable to do the one thing this feature must get right —
 * rejecting *"a banner glimpsed behind another booth"* (the ticket's own named
 * false positive). OCR reads all text in the frame with no notion of which
 * booth is the subject, so it would happily attribute a neighbour's banner to
 * the photo. A vision model can be asked "whose booth is the SUBJECT of this
 * photo?" and can decline. Hence a new `AI.run` rail (John's call, 2026-07-15).
 *
 * ⚠️ OPERATIONAL PREREQUISITE: `@cf/meta/llama-3.2-11b-vision-instruct`
 * requires a ONE-TIME per-account Meta license acceptance before it will serve.
 * Until that is done every call fails. Run once per Cloudflare account:
 *
 *   curl https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/ai/run/@cf/meta/llama-3.2-11b-vision-instruct \
 *     -X POST -H "Authorization: Bearer $TOKEN" -d '{"prompt":"agree"}'
 *
 * ── Never invent ──────────────────────────────────────────────────────────
 * The prompt forbids guessing a URL/phone/city that isn't legibly on the sign.
 * A hallucinated website on a public vendor record is worse than a missing one:
 * it is a factual claim about a real business we'd be publishing.
 */

/**
 * Vision model. Kept as a constant (not inlined) so it is swappable in one
 * place, mirroring WORKERS_AI_MODEL's role for the text model. NOT the same
 * model as the text lane — that one (llama-3.3-70b) has no image input.
 */
export const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

/** Cap the model's output — we want a small JSON object, not an essay. */
const MAX_TOKENS = 384;

export type BoothKind = "booth" | "general" | "unclear";

export interface BoothIdentification {
  /** booth = a vendor's stall is the subject; general = fair scenery. */
  kind: BoothKind;
  /** Business name EXACTLY as it appears on signage, or null. */
  businessName: string | null;
  /** Only when legibly printed on the sign. Never inferred from the name. */
  website: string | null;
  /** What they sell, if evident. Free-form short tokens. */
  products: string[];
  /** Model's self-reported confidence, clamped 0..1. */
  confidence: number;
  /** Short reason — surfaced to the operator when staging for review. */
  rationale: string;
}

/** A total failure to identify. Callers stage/skip rather than write. */
export const UNIDENTIFIED: BoothIdentification = {
  kind: "unclear",
  businessName: null,
  website: null,
  products: [],
  confidence: 0,
  rationale: "vision model returned nothing usable",
};

export const VISION_PROMPT = `You are looking at ONE photograph taken at a public agricultural fair or craft show.

Decide what the photo IS, then report only what you can actually READ or SEE.

Rules — follow exactly:
1. If a vendor's booth/stall/tent is the MAIN SUBJECT, kind = "booth".
2. If it is general fair scenery (rides, crowds, animals, buildings, food court
   with no single subject booth), kind = "general".
3. If you cannot tell, kind = "unclear".
4. business_name: copy the business name EXACTLY as printed on the booth's own
   banner, table sign, or awning. If the only legible sign belongs to a
   DIFFERENT booth in the background, do NOT use it — that is not this booth.
   If no name is legible, use null.
5. website: ONLY if a web address is legibly printed. Never guess one from the
   business name. Otherwise null.
6. products: short lowercase words for what they sell, ONLY if visible.
7. confidence: 0.0-1.0. Use a LOW value (<0.5) if the sign is partly obscured,
   blurry, at an angle, or if more than one booth competes to be the subject.
8. NEVER invent a name, URL, phone number, or town. Missing is correct;
   inventing is a factual error we would publish.

Reply with ONLY a JSON object, no prose, no markdown fence:
{"kind":"booth|general|unclear","business_name":string|null,"website":string|null,"products":[string],"confidence":number,"rationale":string}`;

/** Minimal shape of the Workers AI binding we need. */
export interface VisionAi {
  run(
    model: string,
    input: { image: number[]; prompt: string; max_tokens?: number }
  ): Promise<unknown>;
}

function clamp01(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return Math.max(0, Math.min(1, v));
}

function cleanString(v: unknown, max = 200): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.toLowerCase() === "null" || s.toLowerCase() === "none") return null;
  return s.slice(0, max);
}

/**
 * Parse the model's reply into a BoothIdentification.
 *
 * Pure + total — exported so the parsing contract is unit-testable without an
 * AI binding, and so a garbage reply degrades to UNIDENTIFIED (→ staged for
 * review) instead of throwing inside the inbound workflow.
 */
export function parseVisionReply(raw: unknown): BoothIdentification {
  // Workers AI response shape varies by model: some return a string, some
  // { response: string }, and a non-string `.response` once crashed the email
  // entrypoint outright (OPE-189). Coerce defensively, exactly as
  // intent-classifier.ts does.
  const text =
    typeof raw === "string"
      ? raw
      : typeof (raw as { response?: unknown })?.response === "string"
        ? (raw as { response: string }).response
        : "";
  if (!text.trim()) return UNIDENTIFIED;

  // Models often wrap JSON in prose or a ```json fence despite instructions.
  // Take the outermost {...} span rather than trusting the whole string.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return UNIDENTIFIED;

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return UNIDENTIFIED;
  }
  if (!obj || typeof obj !== "object") return UNIDENTIFIED;

  const rawKind = typeof obj.kind === "string" ? obj.kind.toLowerCase().trim() : "";
  const kind: BoothKind =
    rawKind === "booth" ? "booth" : rawKind === "general" ? "general" : "unclear";

  const products = Array.isArray(obj.products)
    ? obj.products
        .map((p) => cleanString(p, 60))
        .filter((p): p is string => p !== null)
        .slice(0, 12)
    : [];

  const website = cleanString(obj.website, 300);

  return {
    kind,
    // A "general" photo has no business — drop any name the model volunteered
    // so a scenery shot can never carry a vendor into the write path.
    businessName: kind === "booth" ? cleanString(obj.business_name) : null,
    website: kind === "booth" ? website : null,
    products: kind === "booth" ? products : [],
    confidence: clamp01(obj.confidence),
    rationale: cleanString(obj.rationale, 300) ?? "",
  };
}

/**
 * Run the vision model over one photo's bytes.
 *
 * Never throws: an AI failure returns UNIDENTIFIED so the batch continues and
 * the photo is staged for review rather than sinking the inbound workflow
 * (the OPE-189 lesson — a handler that throws kills the whole email).
 */
export async function identifyBooth(ai: VisionAi, bytes: Uint8Array): Promise<BoothIdentification> {
  try {
    const raw = await ai.run(VISION_MODEL, {
      // The binding expects a plain byte array, not a Uint8Array/ArrayBuffer.
      image: Array.from(bytes),
      prompt: VISION_PROMPT,
      max_tokens: MAX_TOKENS,
    });
    return parseVisionReply(raw);
  } catch {
    return UNIDENTIFIED;
  }
}

/**
 * Auto-write threshold.
 *
 * 0.75 is deliberately strict. The downstream write publishes a real business
 * as a CONFIRMED exhibitor at a real fair; a false positive is a public factual
 * claim about someone else's company. Staging costs John one review click,
 * so the asymmetry says: when in doubt, stage.
 */
export const AUTO_WRITE_CONFIDENCE = 0.75;

export type Disposition =
  | { action: "write"; identification: BoothIdentification }
  | { action: "stage"; identification: BoothIdentification; reason: string }
  | { action: "skip"; identification: BoothIdentification; reason: string };

/**
 * Decide what to do with one identified photo. Pure — the whole auto-write-vs-
 * stage judgment lives here so it can be exhaustively tested.
 */
export function disposition(id: BoothIdentification): Disposition {
  if (id.kind === "general") {
    // Gallery/hero handling for scenery is OPE-205, not this ticket.
    return { action: "skip", identification: id, reason: "general fair scene, not a booth" };
  }
  if (id.kind === "unclear") {
    return { action: "stage", identification: id, reason: "could not tell what the photo shows" };
  }
  if (!id.businessName) {
    return { action: "stage", identification: id, reason: "no legible business name on the booth" };
  }
  if (id.confidence < AUTO_WRITE_CONFIDENCE) {
    return {
      action: "stage",
      identification: id,
      reason: `confidence ${id.confidence.toFixed(2)} below ${AUTO_WRITE_CONFIDENCE} threshold`,
    };
  }
  return { action: "write", identification: id };
}
