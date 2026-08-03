export const dynamic = "force-dynamic";
/**
 * OPE-297 — image lane for the /admin/import-url wizard.
 *
 * Facebook event pages are login-walled and robots-blocked, so every fetcher we
 * own bounces off them. That makes FB the intake membrane's largest dark zone,
 * and the events that live ONLY there — small-town fairs, church suppers,
 * one-off festivals — are exactly the ones we never capture. Until now the
 * operator's options were hand-typing or emailing a screenshot to the intake
 * address, which works but round-trips through email with no interactive review.
 *
 * This endpoint takes screenshots straight from the wizard, OCRs them, and
 * returns TEXT in the shape `/api/admin/import-url/extract` already accepts.
 * That is the whole design: the image lane stops at "text", and every step
 * after it — extraction, dedup, venue/promoter resolution, preview, save — is
 * the existing pipeline, unchanged and unforked.
 */
import { NextResponse } from "next/server";
import { withAuthorized } from "@/lib/api/with-auth";
import { getCloudflareAi } from "@/lib/cloudflare";
import { logError } from "@/lib/logger";
import { toMarkdownWithRetry, type ToMarkdownAi } from "@takemetothefair/utils";

/** Per-image ceiling. A phone screenshot is ~1-3 MB; 10 MB is generous. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** An FB event is typically 1-3 shots (event card, about, poster). */
const MAX_IMAGES = 5;
/** Matches the OPE-189 attachment lane: a cold-start miss deserves one retry. */
const OCR_MAX_ATTEMPTS = 2;

const ACCEPTED_PREFIX = "image/";

export const POST = withAuthorized(async ({ request, db }) => {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const files = form.getAll("images").filter((v): v is File => v instanceof File);
  if (files.length === 0) {
    return NextResponse.json(
      { error: "No images provided (field name: 'images')" },
      { status: 400 }
    );
  }
  if (files.length > MAX_IMAGES) {
    return NextResponse.json(
      { error: `Too many images — send at most ${MAX_IMAGES}.` },
      { status: 400 }
    );
  }
  for (const f of files) {
    if (!f.type.toLowerCase().startsWith(ACCEPTED_PREFIX)) {
      return NextResponse.json(
        { error: `'${f.name || "file"}' is ${f.type || "an unknown type"} — images only.` },
        { status: 400 }
      );
    }
    if (f.size > MAX_IMAGE_BYTES) {
      return NextResponse.json(
        {
          error: `'${f.name || "file"}' is ${(f.size / 1024 / 1024).toFixed(1)} MB — the limit is ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`,
        },
        { status: 400 }
      );
    }
  }

  const ai = getCloudflareAi() as unknown as ToMarkdownAi | null;
  if (!ai) {
    return NextResponse.json(
      { error: "AI binding unavailable on this environment" },
      { status: 503 }
    );
  }

  // OCR each image independently. One unreadable shot must not sink the rest:
  // the operator often pastes an event card AND a poster, and either alone is
  // usually enough to extract from.
  const perImage: { name: string; chars: number; outcome: string }[] = [];
  const sections: string[] = [];
  for (const [i, file] of files.entries()) {
    const name = file.name || `pasted-image-${i + 1}`;
    const result = await toMarkdownWithRetry(
      ai,
      { name, blob: file },
      OCR_MAX_ATTEMPTS,
      // Record EVERY attempt, not just the winner — the OPE-189 observability
      // contract. A cold-start timeout that a retry recovers is still the most
      // useful signal we get about AI-binding health.
      (attempt, outcome) => {
        void logError(db, {
          level: "info",
          source: "import-url:extract-image",
          message: `OCR attempt ${attempt} for '${name}': ${outcome}`,
        });
      }
    );
    perImage.push({ name, chars: result.text?.trim().length ?? 0, outcome: result.outcome });
    const text = result.text?.trim();
    if (text) sections.push(text);
  }

  const content = sections.join("\n\n---\n\n").trim();

  if (!content) {
    // Every image failed. Report it as such rather than handing the extractor an
    // empty string and letting it "find no events" — those are different
    // failures and the operator needs to know which one happened.
    await logError(db, {
      level: "warn",
      source: "import-url:extract-image",
      message: "OCR produced no text from any supplied image",
      context: { perImage },
    });
    return NextResponse.json(
      {
        error:
          "Couldn't read any text from those images. A sharper or larger screenshot usually fixes it — or use the paste-text tab.",
        perImage,
      },
      { status: 422 }
    );
  }

  return NextResponse.json({
    content,
    imagesRead: sections.length,
    imagesSubmitted: files.length,
    perImage,
  });
});
