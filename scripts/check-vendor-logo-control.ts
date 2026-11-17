/**
 * OPE-1666 — fail the deploy if the vendor's own logo upload control is not in
 * the client bundle that `/vendor/profile` ships.
 *
 * ## Why a build-artifact assertion, and not a live probe or a unit test
 *
 * - **The served page is auth-gated.** `src/app/vendor/layout.tsx` redirects an
 *   anonymous request to `/login`, so an unauthenticated synthetic probe can
 *   only ever see the redirect. A logged-in probe would need a production vendor
 *   credential in CI, and it would be exactly the slow, network-bound check that
 *   OPE-1518 shows flaking.
 * - **A component render test checks the source, not what ships** (OPE-6 v3.10:
 *   verify the artefact that SHIPS). The control could be present in
 *   `VendorLogoManager.tsx` and still be gone from the page if the import was
 *   dropped or the render branch made unreachable.
 * - **This reads the build `deploy.yml` is about to upload.** It uses the
 *   `.next/app-build-manifest.json` written by the OpenNext build step: the
 *   chunk list for `/vendor/profile/page`, which is exactly what a browser loads
 *   for that route. It needs no network, no timing and no browser, so it gives
 *   the same answer for the same build every time. It cannot become the next
 *   flake.
 *
 * ## What it asserts, and why each assertion is co-located
 *
 * The gallery (OPE-211) ships its OWN `<input type="file"
 * accept="image/jpeg,image/png,image/webp">` on the same page. So "a file input
 * with image types exists" would stay green with the logo control deleted. Each
 * assertion is therefore pinned to the logo control specifically:
 *
 * 1. The literal `"Upload logo"` label, followed within a short window by a
 *    file input whose `accept` includes `image/png`. That is the control as
 *    `VendorLogoManager` renders it (the label and the hidden input are siblings
 *    inside one `<label>`).
 * 2. A `fetch("/api/vendor-photos/logo", {method:"POST"…})` — the upload.
 * 3. A `fetch("/api/vendor-photos/logo", {method:"DELETE"…})` — the remove,
 *    which #1358 shipped alongside upload and replace.
 *
 * ## Positive landmark (OPE-6 v3.8)
 *
 * On a pass it prints how many chunks and bytes it read. A matcher that stopped
 * matching anything would show `0 chunks` instead of a quiet green. If the
 * manifest or the page entry is missing, it FAILS: a guard whose precondition is
 * absent has measured nothing.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PAGE_KEY = "/vendor/profile/page";

/** How far (chars) the file input may sit after the label in minified output. */
const LABEL_TO_INPUT_WINDOW = 300;

export interface ControlCheck {
  name: string;
  test: RegExp;
  why: string;
}

export const CHECKS: ControlCheck[] = [
  {
    name: "logo upload control",
    // `"Upload logo"` then, within the window, a file input that takes PNG.
    // Matches both minified (`type:"file",accept:"…"`) and readable source forms.
    test: new RegExp(
      `"Upload logo"[\\s\\S]{0,${LABEL_TO_INPUT_WINDOW}}?type\\s*[:=]\\s*"file"[\\s\\S]{0,40}?accept\\s*[:=]\\s*"[^"]*image/png`
    ),
    why: 'the "Upload logo" label with its file input — the control a vendor uses to set her logo',
  },
  {
    name: "logo upload request",
    test: /["'`]\/api\/vendor-photos\/logo["'`]\s*,\s*\{\s*method\s*:\s*["']POST["']/,
    why: "POST /api/vendor-photos/logo — the request that stores the uploaded logo",
  },
  {
    name: "logo remove request",
    test: /["'`]\/api\/vendor-photos\/logo["'`]\s*,\s*\{\s*method\s*:\s*["']DELETE["']/,
    why: "DELETE /api/vendor-photos/logo — the request that removes it",
  },
];

export interface Result {
  chunks: number;
  bytes: number;
  missing: ControlCheck[];
}

/** Run every check over the concatenated chunk text. Pure, so it can be tested. */
export function checkBundle(chunkTexts: string[]): Result {
  const all = chunkTexts.join("\n");
  return {
    chunks: chunkTexts.length,
    bytes: all.length,
    missing: CHECKS.filter((c) => !c.test.test(all)),
  };
}

/** Load the chunk texts `/vendor/profile` ships, from a Next build directory. */
export function loadPageChunks(nextDir: string): string[] {
  const manifestPath = join(nextDir, "app-build-manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `${manifestPath} not found — run this after the build. A guard with no build ` +
        `to read has measured nothing, so this is a failure, not a skip.`
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    pages?: Record<string, string[]>;
  };
  const files = manifest.pages?.[PAGE_KEY];
  if (!files || files.length === 0) {
    throw new Error(
      `${PAGE_KEY} is not in ${manifestPath}. Either the route moved (update PAGE_KEY) ` +
        `or the vendor profile page is no longer built.`
    );
  }
  return files.filter((f) => f.endsWith(".js")).map((f) => readFileSync(join(nextDir, f), "utf8"));
}

function main(): void {
  const nextDir = resolve(process.argv[2] ?? ".next");
  let result: Result;
  try {
    result = checkBundle(loadPageChunks(nextDir));
  } catch (err) {
    console.error(`Vendor logo control guard FAILED (OPE-1666): ${(err as Error).message}`);
    process.exit(1);
  }

  if (result.chunks === 0 || result.missing.length > 0) {
    console.error(
      `Vendor logo control guard FAILED (OPE-1666) — read ${result.chunks} chunks ` +
        `(${result.bytes} bytes) for ${PAGE_KEY}.\n`
    );
    for (const m of result.missing) console.error(`  - missing ${m.name}: ${m.why}`);
    console.error(
      "\nA claimed vendor sets her own logo from /vendor/profile (OPE-1112). This build\n" +
        "would ship that page without the control. See src/components/vendors/VendorLogoManager.tsx."
    );
    process.exit(1);
  }

  console.log(
    `OK vendor logo control present — ${CHECKS.length} checks over ${result.chunks} chunks ` +
      `(${result.bytes} bytes) for ${PAGE_KEY}.`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
