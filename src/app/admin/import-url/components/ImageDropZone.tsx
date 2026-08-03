"use client";

/**
 * OPE-297 — screenshot lane for the import wizard.
 *
 * Facebook event pages are login-walled and robots-blocked, so every fetcher we
 * own bounces. The events that live only there (small-town fairs, church
 * suppers) were reachable only by hand-typing or emailing a screenshot to the
 * intake address. This is the interactive path.
 *
 * Design note: this component's whole job is image → TEXT. It hands the OCR'd
 * text to the existing "paste content" box and stops there. Everything after —
 * extraction, dedup, venue/promoter, preview, save — is the pipeline that
 * already works, unforked. It also means the operator SEES what the OCR read
 * before anything is extracted from it, which is the review step the email lane
 * never had.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ImagePlus, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ImageDropZoneProps {
  /** Called with the OCR'd text once at least one image is read. */
  onTextExtracted: (text: string) => void;
  disabled?: boolean;
}

const MAX_IMAGES = 5;

export function ImageDropZone({ onTextExtracted, disabled }: ImageDropZoneProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const runOcr = useCallback(
    async (files: File[]) => {
      const images = files.filter((f) => f.type.toLowerCase().startsWith("image/"));
      if (images.length === 0) {
        setError("That didn't contain an image — drop a screenshot or PNG/JPEG.");
        return;
      }
      setBusy(true);
      setError(null);
      setNote(null);
      try {
        const form = new FormData();
        for (const f of images.slice(0, MAX_IMAGES)) form.append("images", f);
        const res = await fetch("/api/admin/import-url/extract-image", {
          method: "POST",
          body: form,
        });
        const data = (await res.json().catch(() => ({}))) as {
          content?: string;
          error?: string;
          imagesRead?: number;
          imagesSubmitted?: number;
        };
        if (!res.ok || !data.content) {
          setError(data.error ?? `Extraction failed (${res.status}).`);
          return;
        }
        // Partial success is worth saying out loud: the operator should know a
        // shot was unreadable rather than wonder why a field is missing later.
        if (
          typeof data.imagesRead === "number" &&
          typeof data.imagesSubmitted === "number" &&
          data.imagesRead < data.imagesSubmitted
        ) {
          setNote(
            `Read ${data.imagesRead} of ${data.imagesSubmitted} images — check the text below for gaps.`
          );
        }
        onTextExtracted(data.content);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Extraction failed.");
      } finally {
        setBusy(false);
      }
    },
    [onTextExtracted]
  );

  // Clipboard paste (Ctrl/Cmd+V a screenshot). Bound to the document because a
  // paste of an image usually happens without focusing any particular element —
  // requiring a click into a box first is the friction this feature exists to
  // remove. Ignored while a text field has focus so pasting prose still works.
  useEffect(() => {
    if (disabled) return;
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || target?.isContentEditable) return;
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length === 0) return;
      e.preventDefault();
      void runOcr(files);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [runOcr, disabled]);

  return (
    <div className="space-y-2">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled && !busy) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (disabled || busy) return;
          void runOcr(Array.from(e.dataTransfer.files));
        }}
        className={`rounded-lg border-2 border-dashed p-6 text-center transition-colors ${
          dragging ? "border-primary bg-primary/5" : "border-border"
        } ${disabled ? "opacity-50" : ""}`}
      >
        {busy ? (
          <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            Reading the screenshot…
          </div>
        ) : (
          <>
            <ImagePlus className="w-6 h-6 mx-auto text-muted-foreground" />
            <p className="mt-2 text-sm text-foreground">
              Drop a Facebook screenshot here, or press{" "}
              <kbd className="px-1 py-0.5 rounded border border-border text-xs">Ctrl/Cmd+V</kbd> to
              paste one
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Up to {MAX_IMAGES} images — event card, about section, poster. The text lands below
              for review before anything is extracted.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              disabled={disabled}
              onClick={() => fileInputRef.current?.click()}
            >
              Choose images
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = "";
                if (files.length) void runOcr(files);
              }}
            />
          </>
        )}
      </div>

      {note && <p className="text-xs text-amber-700 dark:text-amber-400">{note}</p>}
      {error && (
        <div className="flex items-start gap-2 text-xs text-destructive">
          <span className="flex-1">{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss">
            <X className="w-3 h-3" />
          </button>
        </div>
      )}
    </div>
  );
}
