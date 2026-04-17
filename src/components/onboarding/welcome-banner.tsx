"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Sparkles, X } from "lucide-react";

interface Props {
  storageKey: string;
  title: string;
  body: string;
}

/**
 * Shows a small post-signup welcome banner when the URL contains ?welcome=1.
 * Dismissible, remembered per session via sessionStorage under `storageKey`.
 */
export function WelcomeBanner({ storageKey, title, body }: Props) {
  const params = useSearchParams();
  const welcomeFlag = params.get("welcome") === "1";
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    if (!welcomeFlag) return;
    try {
      if (sessionStorage.getItem(storageKey) === "1") return;
    } catch {
      /* ignore */
    }
    setDismissed(false);
  }, [welcomeFlag, storageKey]);

  if (!welcomeFlag || dismissed) return null;

  const handleDismiss = () => {
    try {
      sessionStorage.setItem(storageKey, "1");
    } catch {
      /* ignore */
    }
    setDismissed(true);
  };

  return (
    <div className="mb-6 rounded-lg border border-amber-dark/30 bg-amber-light p-4">
      <div className="flex items-start gap-3">
        <Sparkles className="w-5 h-5 text-amber-dark flex-shrink-0 mt-0.5" aria-hidden />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-stone-900">{title}</p>
          <p className="text-sm text-stone-900/90 mt-0.5">{body}</p>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          className="text-stone-600 hover:text-stone-900 p-1 -mr-1"
          aria-label="Dismiss"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
