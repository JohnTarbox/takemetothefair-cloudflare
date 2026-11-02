"use client";

/**
 * OPE-1558 — one screen, no login. See src/lib/list-your-event/payload.ts for
 * why this posts to the existing /api/suggest-event/submit rather than a new
 * writer.
 *
 * Flow: fill → (dedup check) → submit → confirmation. The dedup check is the
 * same `findDuplicate` every other intake uses (via /check-duplicate). On a
 * same-event hit the organizer is NOT dead-ended (OPE-636's lesson): they can
 * open the existing listing, email a correction to it, or say "mine is a
 * different event" and list anyway — the route still records the match as
 * `possible_duplicate_of` for the reviewer, so the escape costs no safety.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Script from "next/script";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { EVENT_CATEGORIES, PUBLIC_EVENT_STATUSES } from "@/lib/constants";
import { trackFunnelInteracted, trackFunnelView, makeSubmitAttemptTracker } from "@/lib/analytics";
import {
  EMPTY_LIST_YOUR_EVENT_INPUT,
  LIST_YOUR_EVENT_STATE_OPTIONS,
  buildListYourEventPayload,
  validateListYourEvent,
  type ListYourEventErrors,
  type ListYourEventField,
  type ListYourEventInput,
} from "@/lib/list-your-event/payload";

// Turnstile widget types — must stay structurally identical to the copies in
// suggest-event/page.tsx and (auth)/register/page.tsx, or the global
// augmentation conflicts at type-check.
declare global {
  interface Window {
    turnstile?: {
      render: (container: string | HTMLElement, options: TurnstileOptions) => string;
      reset: (widgetId: string) => void;
      remove: (widgetId: string) => void;
      getResponse: (widgetId: string) => string | undefined;
    };
  }
}

interface TurnstileOptions {
  sitekey: string;
  callback?: (token: string) => void;
  "expired-callback"?: () => void;
  "error-callback"?: (error: string) => void;
  // OPE-173 — "invisible" is NOT a valid explicit-render size (Turnstile throws).
  size?: "normal" | "compact" | "flexible";
  theme?: "light" | "dark" | "auto";
}

interface ExistingEvent {
  id: string;
  slug: string;
  name: string;
  startDate: string | null;
  status: string;
}

interface DuplicateResponse {
  success: boolean;
  isDuplicate?: boolean;
  identifiesSameEvent?: boolean;
  existingEvent?: ExistingEvent;
}

interface SubmitResponse {
  success: boolean;
  error?: string;
  retryAfter?: number;
  event?: { id: string; slug: string; name: string };
  receiptSent?: boolean;
}

type Phase = "form" | "duplicate" | "submitting" | "done";

const PUBLIC_STATUSES = new Set<string>(PUBLIC_EVENT_STATUSES);

export function ListEventForm() {
  const [input, setInput] = useState<ListYourEventInput>(EMPTY_LIST_YOUR_EVENT_INPUT);
  const [errors, setErrors] = useState<ListYourEventErrors>({});
  const [formError, setFormError] = useState("");
  const [phase, setPhase] = useState<Phase>("form");
  const [duplicate, setDuplicate] = useState<ExistingEvent | null>(null);
  const [result, setResult] = useState<{ name: string; receiptSent: boolean } | null>(null);

  // Turnstile — the route requires a token from an anonymous caller.
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  const [turnstileToken, setTurnstileToken] = useState("");
  const widgetId = useRef<string | null>(null);
  const widgetRef = useRef<HTMLDivElement>(null);

  const initTurnstile = useCallback(() => {
    if (!siteKey || !window.turnstile || !widgetRef.current) return;
    if (widgetId.current) {
      try {
        window.turnstile.remove(widgetId.current);
      } catch {
        // already gone
      }
    }
    // OPE-173 — no explicit `size`; the sitekey's dashboard mode decides.
    widgetId.current = window.turnstile.render(widgetRef.current, {
      sitekey: siteKey,
      callback: (t: string) => setTurnstileToken(t),
      "expired-callback": () => setTurnstileToken(""),
      "error-callback": () => setTurnstileToken(""),
    });
  }, [siteKey]);

  const resetTurnstile = useCallback(() => {
    if (window.turnstile && widgetId.current) {
      try {
        window.turnstile.reset(widgetId.current);
      } catch {
        // widget gone
      }
    }
    setTurnstileToken("");
  }, []);

  // If the script was already loaded by an earlier client navigation, onLoad
  // will not fire again — render directly.
  useEffect(() => {
    if (window.turnstile) initTurnstile();
  }, [initTurnstile]);

  // Funnel step 1, once per mount.
  useEffect(() => {
    trackFunnelView("list");
  }, []);

  // Funnel step 2, latched to first touch (the beacon is rate-limited; see
  // funnel-steps.ts — re-firing per keystroke would drop the steps measured).
  const interacted = useRef(false);
  const markInteracted = useCallback(() => {
    if (interacted.current) return;
    interacted.current = true;
    trackFunnelInteracted("list");
  }, []);
  const trackAttempt = useMemo(() => makeSubmitAttemptTracker("list"), []);

  const set = (field: ListYourEventField) => (value: string) => {
    markInteracted();
    setInput((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const categoryOptions = useMemo(
    () => [
      { value: "", label: "Choose one (optional)" },
      ...[...EVENT_CATEGORIES].sort().map((c) => ({ value: c, label: c })),
    ],
    []
  );

  const submit = async () => {
    setPhase("submitting");
    setFormError("");
    try {
      const res = await fetch("/api/suggest-event/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...buildListYourEventPayload(input),
          turnstileToken: turnstileToken || undefined,
        }),
      });
      const data = (await res.json()) as SubmitResponse;
      if (!data.success) {
        if (res.status === 429) {
          const minutes = Math.ceil((data.retryAfter || 3600) / 60);
          setFormError(
            `Too many submissions from this connection. Please try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`
          );
        } else {
          setFormError(data.error || "We couldn't save your event. Please try again.");
        }
        resetTurnstile();
        setPhase("form");
        return;
      }
      setResult({ name: data.event?.name ?? input.name.trim(), receiptSent: !!data.receiptSent });
      setPhase("done");
    } catch {
      setFormError("We couldn't reach the server. Check your connection and try again.");
      resetTurnstile();
      setPhase("form");
    }
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Funnel step 3 on the ATTEMPT, before any validation or POST (OPE-364
    // rework), and markInteracted first so submitted ≤ interacted by
    // construction.
    markInteracted();
    trackAttempt();

    const v = validateListYourEvent(input);
    setErrors(v);
    if (Object.keys(v).length > 0) {
      setFormError("Please fix the highlighted fields.");
      return;
    }
    if (siteKey && !turnstileToken) {
      setFormError("Please complete the quick check below the form, then press List my event.");
      return;
    }

    setPhase("submitting");
    setFormError("");
    const payload = buildListYourEventPayload(input);
    try {
      const res = await fetch("/api/suggest-event/check-duplicate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: payload.name,
          startDate: payload.startDate,
          venueName: payload.venueName,
          venueCity: payload.venueCity,
          venueState: payload.venueState,
          sourceUrl: payload.sourceUrl ?? null,
        }),
      });
      const dup = (await res.json()) as DuplicateResponse;
      // OPE-454 — gate on identifiesSameEvent, not isDuplicate: a series URL
      // match means "same organizer page", not "same event".
      if (dup.success && dup.isDuplicate && dup.identifiesSameEvent && dup.existingEvent) {
        setDuplicate(dup.existingEvent);
        setPhase("duplicate");
        return;
      }
    } catch {
      // A dedup outage must not cost the organizer their listing. The submit
      // route runs its own duplicate detection and flags the row for review.
    }
    await submit();
  };

  if (phase === "done" && result) {
    return (
      <div className="rounded-lg border border-border bg-card p-6" role="status">
        <div className="flex items-center gap-2 text-lg font-semibold text-foreground">
          <Check className="h-5 w-5 text-green-600" aria-hidden />
          Thanks — we&apos;ve got {result.name}.
        </div>
        <p className="mt-3 text-foreground">
          Every listing is checked by a person before it goes live on the site, so it won&apos;t
          show up right away.
        </p>
        {result.receiptSent ? (
          <p className="mt-3 text-foreground">
            We&apos;ve emailed a receipt to <strong>{input.email.trim()}</strong>. If anything needs
            changing, reply to that email and it will reach us.
          </p>
        ) : (
          <p className="mt-3 text-foreground">
            If anything needs changing, email{" "}
            <a className="text-royal hover:underline" href="mailto:corrections@meetmeatthefair.com">
              corrections@meetmeatthefair.com
            </a>{" "}
            with the event name.
          </p>
        )}
        <div className="mt-6 flex flex-wrap gap-3">
          <Button
            type="button"
            onClick={() => {
              setInput((prev) => ({ ...EMPTY_LIST_YOUR_EVENT_INPUT, email: prev.email }));
              setResult(null);
              setDuplicate(null);
              resetTurnstile();
              setPhase("form");
            }}
          >
            List another event
          </Button>
          <Link
            href="/events"
            className="inline-flex items-center rounded-lg border border-border px-4 py-2 text-sm"
          >
            Browse events
          </Link>
        </div>
      </div>
    );
  }

  if (phase === "duplicate" && duplicate) {
    const isPublic = PUBLIC_STATUSES.has(duplicate.status);
    const correctionHref = `mailto:corrections@meetmeatthefair.com?subject=${encodeURIComponent(
      `Correction: ${duplicate.name}`
    )}`;
    return (
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-6 text-amber-950">
        <div className="flex items-center gap-2 text-lg font-semibold">
          <AlertTriangle className="h-5 w-5" aria-hidden />
          We may already have this one
        </div>
        <p className="mt-3">
          <strong>{duplicate.name}</strong>
          {duplicate.startDate ? ` (${duplicate.startDate.slice(0, 10)})` : ""}{" "}
          {isPublic ? "is already listed." : "has already been sent in and is waiting for review."}
        </p>
        <p className="mt-2">
          If it&apos;s yours and something is wrong or missing, the quickest fix is to tell us what
          to change.
        </p>
        <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          {isPublic && (
            <Link
              href={`/events/${duplicate.slug}`}
              className="inline-flex items-center justify-center rounded-lg border border-amber-400 bg-white px-4 py-2 text-sm"
            >
              View the listing
            </Link>
          )}
          <a
            href={correctionHref}
            className="inline-flex items-center justify-center rounded-lg border border-amber-400 bg-white px-4 py-2 text-sm"
          >
            Send a correction
          </a>
          <Button type="button" variant="outline" onClick={() => void submit()}>
            Mine is a different event — list it
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setDuplicate(null);
              setPhase("form");
            }}
          >
            Back to the form
          </Button>
        </div>
      </div>
    );
  }

  const busy = phase === "submitting";

  return (
    <form onSubmit={onSubmit} onFocus={markInteracted} noValidate className="space-y-4">
      {siteKey && (
        <Script
          src="https://challenges.cloudflare.com/turnstile/v0/api.js"
          strategy="afterInteractive"
          onLoad={initTurnstile}
        />
      )}

      <Input
        label="Event name"
        name="name"
        required
        autoComplete="off"
        placeholder="e.g. Hollis Elementary PTG Holiday Craft Fair"
        value={input.name}
        onChange={(e) => set("name")(e.target.value)}
        error={errors.name}
      />

      <div className="grid grid-cols-2 gap-3">
        <Input
          label="First day"
          name="startDate"
          type="date"
          required
          value={input.startDate}
          onChange={(e) => set("startDate")(e.target.value)}
          error={errors.startDate}
        />
        <Input
          label="Last day (if more than one)"
          name="endDate"
          type="date"
          min={input.startDate || undefined}
          value={input.endDate}
          onChange={(e) => set("endDate")(e.target.value)}
          error={errors.endDate}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Input
          label="Town"
          name="town"
          required
          autoComplete="address-level2"
          value={input.town}
          onChange={(e) => set("town")(e.target.value)}
          error={errors.town}
        />
        <Select
          label="State"
          name="state"
          required
          value={input.state}
          onChange={(e) => set("state")(e.target.value)}
          error={errors.state}
          options={[{ value: "", label: "Choose…" }, ...LIST_YOUR_EVENT_STATE_OPTIONS]}
        />
      </div>

      <Input
        label="Venue (optional)"
        name="venueName"
        placeholder="e.g. Town Hall, a school, a fairground"
        value={input.venueName}
        onChange={(e) => set("venueName")(e.target.value)}
        error={errors.venueName}
      />

      <Select
        label="Type of event (optional)"
        name="category"
        value={input.category}
        onChange={(e) => set("category")(e.target.value)}
        options={categoryOptions}
      />

      <Input
        label="Event website or Facebook page (optional)"
        name="website"
        inputMode="url"
        autoComplete="url"
        placeholder="example.com"
        value={input.website}
        onChange={(e) => set("website")(e.target.value)}
        error={errors.website}
      />

      <Input
        label="Your email"
        name="email"
        type="email"
        required
        autoComplete="email"
        value={input.email}
        onChange={(e) => set("email")(e.target.value)}
        error={errors.email}
        aria-describedby="email-use"
      />
      <p id="email-use" className="-mt-2 text-sm text-muted-foreground">
        Only used to reach you about this listing. Not shown on the site.
      </p>

      <div ref={widgetRef} className="flex justify-center" />

      {formError && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
          {formError}
        </p>
      )}

      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
            Sending…
          </>
        ) : (
          "List my event — free"
        )}
      </Button>
      <p className="text-center text-sm text-muted-foreground">
        No account needed. A person reviews every listing before it goes live.
      </p>
    </form>
  );
}
