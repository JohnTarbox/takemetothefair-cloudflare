"use client";

import { useEffect, useRef, useState } from "react";

export type AutosaveStatus = "idle" | "saving" | "saved" | "error";

interface UseAutosaveOptions<T> {
  /** The value to save. Autosave fires when this changes and idle settles. */
  value: T;
  /** The async save function. Receives the current value and optional AbortSignal. */
  onSave: (value: T, signal: AbortSignal) => Promise<void>;
  /** ms of idle time before a save fires. Default: 2000. */
  debounceMs?: number;
  /** Suppress autosave until this returns true. */
  enabled?: boolean;
  /** Optional equality check to skip no-op saves. Default: referential equality. */
  isEqual?: (a: T, b: T) => boolean;
}

interface UseAutosaveResult {
  status: AutosaveStatus;
  lastSavedAt: number | null;
  error: string | null;
  /** Force an immediate save outside of debounce. */
  saveNow: () => Promise<void>;
}

/**
 * Debounced autosave. Cancels in-flight saves when new input arrives so the
 * latest value wins even if an earlier save is still running.
 *
 * Does not save on mount — only when `value` changes after the first render,
 * so loading an initial draft doesn't trigger a gratuitous PUT.
 */
export function useAutosave<T>({
  value,
  onSave,
  debounceMs = 2000,
  enabled = true,
  isEqual = Object.is,
}: UseAutosaveOptions<T>): UseAutosaveResult {
  const [status, setStatus] = useState<AutosaveStatus>("idle");
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const lastSavedValueRef = useRef<T>(value);
  const initializedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  const runSave = async (val: T) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus("saving");
    setError(null);
    try {
      await onSaveRef.current(val, controller.signal);
      if (controller.signal.aborted) return;
      lastSavedValueRef.current = val;
      setLastSavedAt(Date.now());
      setStatus("saved");
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : "Could not save");
      setStatus("error");
    }
  };

  const saveNow = async () => {
    if (!enabled) return;
    await runSave(value);
  };

  useEffect(() => {
    if (!enabled) return;
    // Skip the first render — loading an initial value shouldn't trigger a save.
    if (!initializedRef.current) {
      initializedRef.current = true;
      lastSavedValueRef.current = value;
      return;
    }
    if (isEqual(value, lastSavedValueRef.current)) return;

    const timer = setTimeout(() => {
      void runSave(value);
    }, debounceMs);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, enabled, debounceMs]);

  // Cancel pending saves on unmount
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  return { status, lastSavedAt, error, saveNow };
}

/**
 * Render-ready "saved 2m ago" string. Re-render yourself on an interval if you
 * want it to tick.
 */
export function formatSavedAgo(lastSavedAt: number | null): string | null {
  if (!lastSavedAt) return null;
  const seconds = Math.max(1, Math.floor((Date.now() - lastSavedAt) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}
