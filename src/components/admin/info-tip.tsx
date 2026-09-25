"use client";

/**
 * OPE-1159 — the ⓘ beside an /admin/analytics card title.
 *
 * One small dependency-free popover, because the admin has no tooltip library
 * and a card definition is four short lines, not a UI framework's worth of
 * behaviour. What it must do, and why:
 *
 *  - **Keyboard:** it is a real `<button>`, so Tab reaches it and Enter/Space
 *    toggle it; Escape closes it and returns focus.
 *  - **Screen readers:** the panel is always in the DOM and the button points at
 *    it with `aria-describedby`, so the definition is read on focus without
 *    opening anything.
 *  - **Touch:** hover does not exist on a phone, so a tap toggles it; a tap
 *    anywhere else closes it.
 *  - **Never clips:** the panel is `position: fixed` and clamped to the viewport
 *    with a 12px margin, so neither the screen edge nor a card's
 *    `overflow: hidden` can cut it off. It flips above the icon when there is no
 *    room below, and closes on scroll rather than drifting away from its icon.
 *  - **Inside a clickable card:** several cards are links. The click is stopped
 *    here so opening the tip never navigates.
 *  - **Valid inside a `<p>`:** several card titles are paragraphs, and a `<div>`
 *    or `<dl>` may not sit in one. The panel is portalled to `<body>` (which also
 *    frees it from every ancestor's `overflow`); `aria-describedby` still
 *    resolves, because it is an id reference, not a DOM-ancestry one. The panel
 *    exists only after mount, so server HTML carries the button alone.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";

export interface InfoTipLine {
  label: string;
  text: string;
}

const MARGIN = 12;
const MAX_WIDTH = 320;

export function InfoTip({
  title,
  lines,
  note,
}: {
  /** The card title, for the button's accessible name. */
  title: string;
  lines: InfoTipLine[];
  /** OPE-808 render state of this tile right now, when it is not a clean reading. */
  note?: string | null;
}) {
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const place = useCallback(() => {
    const btn = buttonRef.current;
    const panel = panelRef.current;
    if (!btn || !panel) return;
    const r = btn.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(MAX_WIDTH, vw - MARGIN * 2);
    const left = Math.min(Math.max(r.left + r.width / 2 - width / 2, MARGIN), vw - width - MARGIN);
    const height = panel.offsetHeight;
    const below = r.bottom + 6;
    const top =
      below + height + MARGIN > vh && r.top - 6 - height > MARGIN ? r.top - 6 - height : below;
    setPos({ left, top, width });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!buttonRef.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false);
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  return (
    <span className="relative z-10 inline-flex align-middle">
      <button
        ref={buttonRef}
        type="button"
        aria-label={`About: ${title}`}
        aria-describedby={id}
        aria-expanded={open}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-royal"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {mounted &&
        createPortal(
          <div
            ref={panelRef}
            id={id}
            role="tooltip"
            // Always rendered so aria-describedby resolves; hidden visually when closed.
            style={
              open && pos
                ? { position: "fixed", left: pos.left, top: pos.top, width: pos.width }
                : { position: "fixed", left: -9999, top: 0, width: MAX_WIDTH }
            }
            className={`z-50 rounded-md border border-border bg-card p-3 text-left text-xs font-normal normal-case tracking-normal text-foreground shadow-lg ${
              open ? "visible" : "invisible"
            }`}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            <dl className="space-y-1.5">
              {lines.map((l) => (
                <div key={l.label}>
                  <dt className="font-semibold">{l.label}</dt>
                  <dd className="text-muted-foreground">{l.text}</dd>
                </div>
              ))}
            </dl>
            {note && (
              <p className="mt-2 border-t border-border pt-2 font-medium text-amber-700">
                Now: {note}
              </p>
            )}
          </div>,
          document.body
        )}
    </span>
  );
}
