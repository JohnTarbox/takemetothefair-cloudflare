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
 * a pointer press, a key press, a touch, or a mouse wheel. Listeners are on
 * `window` in the CAPTURE phase so a handler that stops propagation cannot
 * hide the interaction, and all of them are removed as soon as one fires.
 *
 * `scroll` and `focusin` were in the first cut and are deliberately OUT: the
 * crawler kept coming through them. 10-16 → 10-18 (after the 10-16 00:41Z
 * deploy) prod still logged 382 / 55 / 196 `claim_view` rows, every one a
 * different vendor, all desktop, and zero later steps on any day. A renderer
 * scrolls programmatically to trigger lazy content (`scroll` fires; `wheel`
 * does not), and `focusin` fires when the page itself takes focus. A human
 * who only reads still reaches `claim_view` through Continue or any press.
 *
 * The callback receives the event type that fired it (or "direct" for
 * `fire()`), so the beacon can record WHICH signal admitted the view — the
 * next crawler that gets through names its own door.
 *
 * Returns a `fire()` function so a caller that sees a stronger signal of its
 * own (a button activated by a synthetic click, say) can trigger it directly;
 * the once-per-mount guard is shared, so the two paths can never double-fire.
 */
export const HUMAN_INTERACTION_EVENTS = ["pointerdown", "keydown", "touchstart", "wheel"] as const;

/** Events a page load alone can produce — must NEVER admit a view. */
export const RENDERER_PRODUCIBLE_EVENTS = ["scroll", "focusin", "focus", "load"] as const;

export type InteractionTrigger = (typeof HUMAN_INTERACTION_EVENTS)[number] | "direct";

export function useOnFirstHumanInteraction(
  callback: (trigger: InteractionTrigger) => void
): () => void {
  const fired = useRef(false);
  const cb = useRef(callback);
  cb.current = callback;

  const fireWith = useRef((trigger: InteractionTrigger) => {
    if (fired.current) return;
    fired.current = true;
    cb.current(trigger);
  }).current;
  const fire = useRef(() => fireWith("direct")).current;

  useEffect(() => {
    if (fired.current) return;
    const opts: AddEventListenerOptions = { capture: true, passive: true };
    const handler = (e: Event) => {
      cleanup();
      fireWith(e.type as InteractionTrigger);
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
  }, [fireWith]);

  return fire;
}
