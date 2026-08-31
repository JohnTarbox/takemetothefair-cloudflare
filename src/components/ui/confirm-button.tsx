"use client";

import { useEffect, useRef, useState } from "react";

/**
 * OPE-686 — an in-page confirmation, because a native dialog is a wall.
 *
 * `window.confirm` blocks the renderer's main thread. For a person that is
 * merely abrupt; for browser automation it is fatal — on 2026-08-31 a Delete
 * photo click froze the Chrome extension outright:
 * `Input.dispatchMouseEvent` timed out after 30s and every subsequent
 * screenshot failed with "Script injection timed out". The session ended with
 * the modal still open and a human asked to click OK by hand.
 *
 * There was no in-page confirm anywhere in the codebase to reuse — 22 native
 * `confirm`/`alert` call sites across /admin and no dialog primitive — so this
 * is the first one. It is deliberately small: two buttons in the flow of the
 * page, no portal, no focus trap library, no overlay. A destructive action
 * needs a second click, not a modal.
 *
 * Keyboard: Escape cancels, and focus moves to the confirm button when armed,
 * so the pattern is reachable without a mouse.
 */
export function ConfirmButton({
  onConfirm,
  children,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  prompt,
  className,
  confirmClassName = "text-xs px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700",
  cancelClassName = "text-xs px-2 py-1 rounded border border-border hover:bg-muted",
  disabled,
  "aria-label": ariaLabel,
}: {
  onConfirm: () => void | Promise<void>;
  children: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Shown beside the buttons while armed. Keep it short — it sits inline. */
  prompt?: string;
  className?: string;
  confirmClassName?: string;
  cancelClassName?: string;
  disabled?: boolean;
  "aria-label"?: string;
}) {
  const [armed, setArmed] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (armed) confirmRef.current?.focus();
  }, [armed]);

  if (!armed) {
    return (
      <button
        type="button"
        className={className}
        disabled={disabled}
        aria-label={ariaLabel}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setArmed(true);
        }}
      >
        {children}
      </button>
    );
  }

  return (
    <span
      className="inline-flex items-center gap-1"
      role="group"
      aria-label={prompt ?? "Confirm this action"}
      onKeyDown={(e) => {
        if (e.key === "Escape") setArmed(false);
      }}
    >
      {prompt ? <span className="text-xs text-muted-foreground">{prompt}</span> : null}
      <button
        ref={confirmRef}
        type="button"
        className={confirmClassName}
        disabled={disabled}
        onClick={async (e) => {
          e.preventDefault();
          e.stopPropagation();
          setArmed(false);
          await onConfirm();
        }}
      >
        {confirmLabel}
      </button>
      <button
        type="button"
        className={cancelClassName}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setArmed(false);
        }}
      >
        {cancelLabel}
      </button>
    </span>
  );
}
