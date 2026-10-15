"use client";

import { useEffect, useRef } from "react";

/**
 * OPE-364 rework — run `callback` at most ONCE per mount, on the first sign of
 * a human on the page, never on render.
 *
 * Why: `claim_view` fired on mount, and a JS-rendering crawler walking
 * /claim/<type>/<slug> mounts the page like anyone else. Prod went from 23
 * `claim_view` rows all-time to 282 in ~13h (2026-10-14 23:41Z → 10-15
 * ~13:00Z), each a different vendor slug, nearly all desktop. A funnel whose
 * first step counts crawlers makes every later ratio meaningless.
 *
 * The signals are input a renderer does not produce by loading a page:
 * a pointer press, a key press, a touch, a scroll, or focus moving into the
 * document. Listeners are on `window` in the CAPTURE phase so a handler that
 * stops propagation cannot hide the interaction, and all of them are removed
 * as soon as one fires.
 *
 * Returns a `fire()` function so a caller that sees a stronger signal of its
 * own (a button activated by a synthetic click, say) can trigger it directly;
 * the once-per-mount guard is shared, so the two paths can never double-fire.
 */
export const HUMAN_INTERACTION_EVENTS = [
  "pointerdown",
  "keydown",
  "touchstart",
  "scroll",
  "focusin",
] as const;

export function useOnFirstHumanInteraction(callback: () => void): () => void {
  const fired = useRef(false);
  const cb = useRef(callback);
  cb.current = callback;

  const fire = useRef(() => {
    if (fired.current) return;
    fired.current = true;
    cb.current();
  }).current;

  useEffect(() => {
    if (fired.current) return;
    const opts: AddEventListenerOptions = { capture: true, passive: true };
    const handler = () => {
      cleanup();
      fire();
    };
    function cleanup() {
      for (const type of HUMAN_INTERACTION_EVENTS) {
        window.removeEventListener(type, handler, opts);
      }
    }
    for (const type of HUMAN_INTERACTION_EVENTS) {
      window.addEventListener(type, handler, opts);
    }
    return cleanup;
  }, [fire]);

  return fire;
}
