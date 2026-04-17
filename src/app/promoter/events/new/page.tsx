"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import {
  ArrowLeft,
  ArrowRight,
  Calendar,
  CheckCircle2,
  Cloud,
  DollarSign,
  ExternalLink,
  FileText,
  MapPin,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { WizardSteps, type WizardStep } from "@/components/ui/wizard-steps";
import { DailyScheduleInput, type EventDayInput } from "@/components/events/DailyScheduleInput";
import { VenueComboSearch } from "@/components/venue-combo-search";
import { WelcomeBanner } from "@/components/onboarding/welcome-banner";

export const runtime = "edge";

interface Venue {
  id: string;
  name: string;
  city: string;
  state: string;
  googlePlaceId: string | null;
}

type Stage = "basics" | "schedule" | "vendor" | "review";

const WIZARD_STEPS: WizardStep[] = [
  { key: "basics", label: "Basics" },
  { key: "schedule", label: "Schedule" },
  { key: "vendor", label: "Vendor info" },
  { key: "review", label: "Review" },
];

interface FormState {
  name: string;
  description: string;
  venueId: string;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  categories: string;
  tags: string;
  ticketUrl: string;
  ticketPriceMin: string;
  ticketPriceMax: string;
  imageUrl: string;
  vendorFeeMin: string;
  vendorFeeMax: string;
  vendorFeeNotes: string;
  indoorOutdoor: string;
  estimatedAttendance: string;
  eventScale: string;
  applicationDeadline: string;
  applicationUrl: string;
  applicationInstructions: string;
  walkInsAllowed: boolean;
}

const EMPTY_FORM: FormState = {
  name: "",
  description: "",
  venueId: "",
  startDate: "",
  startTime: "09:00",
  endDate: "",
  endTime: "17:00",
  categories: "",
  tags: "",
  ticketUrl: "",
  ticketPriceMin: "",
  ticketPriceMax: "",
  imageUrl: "",
  vendorFeeMin: "",
  vendorFeeMax: "",
  vendorFeeNotes: "",
  indoorOutdoor: "",
  estimatedAttendance: "",
  eventScale: "",
  applicationDeadline: "",
  applicationUrl: "",
  applicationInstructions: "",
  walkInsAllowed: false,
};

function buildRequestBody(
  form: FormState,
  discontinuousDates: boolean,
  eventDays: EventDayInput[]
): Record<string, unknown> {
  let startDateISO: string | null = null;
  let endDateISO: string | null = null;
  if (discontinuousDates && eventDays.length > 0) {
    const sorted = eventDays.map((d) => d.date).sort();
    startDateISO = new Date(sorted[0] + "T00:00:00").toISOString();
    endDateISO = new Date(sorted[sorted.length - 1] + "T00:00:00").toISOString();
  } else if (form.startDate && form.endDate) {
    startDateISO = new Date(`${form.startDate}T${form.startTime || "09:00"}`).toISOString();
    endDateISO = new Date(`${form.endDate}T${form.endTime || "17:00"}`).toISOString();
  }

  return {
    name: form.name,
    description: form.description || null,
    venueId: form.venueId || null,
    startDate: startDateISO,
    endDate: endDateISO,
    discontinuousDates,
    categories: form.categories
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean),
    tags: form.tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
    ticketUrl: form.ticketUrl || null,
    ticketPriceMin: form.ticketPriceMin ? parseFloat(form.ticketPriceMin) : null,
    ticketPriceMax: form.ticketPriceMax ? parseFloat(form.ticketPriceMax) : null,
    imageUrl: form.imageUrl || null,
    eventDays,
    vendorFeeMin: form.vendorFeeMin ? parseFloat(form.vendorFeeMin) : null,
    vendorFeeMax: form.vendorFeeMax ? parseFloat(form.vendorFeeMax) : null,
    vendorFeeNotes: form.vendorFeeNotes || null,
    indoorOutdoor: form.indoorOutdoor || null,
    estimatedAttendance: form.estimatedAttendance ? parseInt(form.estimatedAttendance, 10) : null,
    eventScale: form.eventScale || null,
    applicationDeadline: form.applicationDeadline
      ? new Date(form.applicationDeadline + "T00:00:00").toISOString()
      : null,
    applicationUrl: form.applicationUrl || null,
    applicationInstructions: form.applicationInstructions || null,
    walkInsAllowed: form.walkInsAllowed || null,
  };
}

function CreateEventWizard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const draftIdParam = searchParams.get("draft");
  const duplicateIdParam = searchParams.get("duplicate");

  const [stage, setStage] = useState<Stage>("basics");
  const [venues, setVenues] = useState<Venue[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [eventDays, setEventDays] = useState<EventDayInput[]>([]);
  const [discontinuousDates, setDiscontinuousDates] = useState(false);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [stageError, setStageError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);

  const stageIndex = WIZARD_STEPS.findIndex((s) => s.key === stage);

  // Load venues + optional prefill from draft/duplicate
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/venues");
        setVenues((await res.json()) as Venue[]);
      } catch {
        /* non-fatal */
      }

      const prefillId = draftIdParam || duplicateIdParam;
      if (!prefillId) return;
      try {
        const res = await fetch(`/api/promoter/events/draft?id=${encodeURIComponent(prefillId)}`);
        if (!res.ok) return;
        const data = (await res.json()) as {
          event: Record<string, unknown>;
          eventDays: Array<{
            date: string;
            openTime: string;
            closeTime: string;
            notes: string | null;
            closed: boolean;
            vendorOnly: boolean;
          }>;
        };
        const e = data.event;
        const toIsoDate = (v: unknown): string =>
          v ? new Date(v as string).toISOString().substring(0, 10) : "";
        const toTime = (v: unknown): string => {
          if (!v) return "";
          const d = new Date(v as string);
          const hh = d.getUTCHours().toString().padStart(2, "0");
          const mm = d.getUTCMinutes().toString().padStart(2, "0");
          return `${hh}:${mm}`;
        };
        const catArr = (() => {
          try {
            return JSON.parse((e.categories as string) || "[]") as string[];
          } catch {
            return [];
          }
        })();
        const tagArr = (() => {
          try {
            return JSON.parse((e.tags as string) || "[]") as string[];
          } catch {
            return [];
          }
        })();
        const prefillForm: FormState = {
          ...EMPTY_FORM,
          name: duplicateIdParam
            ? `${(e.name as string) ?? ""} (copy)`
            : ((e.name as string) ?? ""),
          description: (e.description as string) ?? "",
          venueId: (e.venueId as string) ?? "",
          startDate: toIsoDate(e.startDate),
          startTime: toTime(e.startDate) || "09:00",
          endDate: toIsoDate(e.endDate),
          endTime: toTime(e.endDate) || "17:00",
          categories: catArr.join(", "),
          tags: tagArr.join(", "),
          ticketUrl: (e.ticketUrl as string) ?? "",
          ticketPriceMin: e.ticketPriceMin != null ? String(e.ticketPriceMin) : "",
          ticketPriceMax: e.ticketPriceMax != null ? String(e.ticketPriceMax) : "",
          imageUrl: (e.imageUrl as string) ?? "",
          vendorFeeMin: e.vendorFeeMin != null ? String(e.vendorFeeMin) : "",
          vendorFeeMax: e.vendorFeeMax != null ? String(e.vendorFeeMax) : "",
          vendorFeeNotes: (e.vendorFeeNotes as string) ?? "",
          indoorOutdoor: (e.indoorOutdoor as string) ?? "",
          estimatedAttendance: e.estimatedAttendance != null ? String(e.estimatedAttendance) : "",
          eventScale: (e.eventScale as string) ?? "",
          applicationDeadline: toIsoDate(e.applicationDeadline),
          applicationUrl: (e.applicationUrl as string) ?? "",
          applicationInstructions: (e.applicationInstructions as string) ?? "",
          walkInsAllowed: !!e.walkInsAllowed,
        };
        setForm(prefillForm);
        setDiscontinuousDates(!!e.discontinuousDates);
        // DailyScheduleInput's EventDayInput expects non-null strings, but the
        // DB column is nullable — normalize here.
        setEventDays(
          (data.eventDays ?? []).map((d) => ({
            date: d.date,
            openTime: d.openTime,
            closeTime: d.closeTime,
            notes: d.notes ?? "",
            closed: !!d.closed,
            vendorOnly: !!d.vendorOnly,
          }))
        );
        // Only treat as existing draft if it was a draft — duplicates start fresh
        if (draftIdParam) setDraftId(prefillId);
      } catch {
        /* non-fatal */
      }
    })();
  }, [draftIdParam, duplicateIdParam]);

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>
  ) => {
    const { name, value, type } = e.target as HTMLInputElement;
    setForm((prev) => ({
      ...prev,
      [name]: type === "checkbox" ? (e.target as HTMLInputElement).checked : value,
    }));
  };

  const handleDaysChange = useCallback((days: EventDayInput[]) => {
    setEventDays(days);
  }, []);

  // Validate the current stage and return the error string, or "" if OK.
  const validateStage = (): string => {
    if (stage === "basics") {
      if (!form.name.trim()) return "Event name is required.";
      return "";
    }
    if (stage === "schedule") {
      if (discontinuousDates) {
        if (eventDays.length === 0) return "Add at least one date in the daily schedule.";
      } else {
        if (!form.startDate || !form.endDate) return "Start and end dates are required.";
        if (new Date(form.startDate) > new Date(form.endDate))
          return "End date must be on or after start date.";
      }
      return "";
    }
    return "";
  };

  const saveDraft = async (submit = false): Promise<{ ok: boolean; id?: string }> => {
    setSaving(true);
    try {
      const body = {
        ...buildRequestBody(form, discontinuousDates, eventDays),
        id: draftId ?? undefined,
        submit,
      };
      const res = await fetch("/api/promoter/events/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as {
        id?: string;
        slug?: string;
        error?: string;
      };
      if (!res.ok) {
        setSubmitError(data.error || "Could not save draft.");
        return { ok: false };
      }
      if (data.id) setDraftId(data.id);
      setLastSavedAt(Date.now());
      return { ok: true, id: data.id };
    } catch {
      setSubmitError("Network error. Please try again.");
      return { ok: false };
    } finally {
      setSaving(false);
    }
  };

  const goNext = async () => {
    setSubmitError("");
    const err = validateStage();
    setStageError(err);
    if (err) return;
    // Only save once we have a name (required for slugification on the server)
    if (form.name.trim()) {
      const saved = await saveDraft(false);
      if (!saved.ok) return;
    }
    const next = WIZARD_STEPS[stageIndex + 1];
    if (next) setStage(next.key as Stage);
  };

  const goBack = () => {
    setStageError("");
    const prev = WIZARD_STEPS[stageIndex - 1];
    if (prev) setStage(prev.key as Stage);
  };

  const handleFinalSubmit = async () => {
    setSubmitError("");
    setSubmitting(true);
    const result = await saveDraft(true);
    setSubmitting(false);
    if (result.ok) {
      router.push("/promoter/events");
    }
  };

  const selectedVenue = venues.find((v) => v.id === form.venueId);
  const startDateTimeStr =
    form.startDate && form.startTime ? `${form.startDate}T${form.startTime}` : null;
  const endDateTimeStr = form.endDate && form.endTime ? `${form.endDate}T${form.endTime}` : null;

  const savedAgo = lastSavedAt
    ? (() => {
        const seconds = Math.max(1, Math.floor((Date.now() - lastSavedAt) / 1000));
        if (seconds < 60) return `${seconds}s ago`;
        const minutes = Math.floor(seconds / 60);
        return `${minutes}m ago`;
      })()
    : null;

  return (
    <div className="max-w-2xl">
      <WelcomeBanner
        storageKey="mmatf.welcome.promoter"
        title="Ready to list your first event?"
        body="Walk through the four steps — you can come back and finish later, we'll save as you go."
      />
      <div className="flex items-baseline justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">
          {draftId ? "Edit draft event" : "Create new event"}
        </h1>
        {savedAgo && (
          <span className="text-xs text-stone-600">
            {saving ? "Saving…" : `Draft saved ${savedAgo}`}
          </span>
        )}
      </div>

      <WizardSteps
        steps={WIZARD_STEPS}
        currentIndex={stageIndex}
        onStepClick={(idx) => {
          if (idx > stageIndex) return; // don't allow skipping forward
          setStage(WIZARD_STEPS[idx].key as Stage);
        }}
      />

      <Card>
        <CardHeader>
          <p className="text-sm text-gray-600">
            {stage === "basics" && "Start with the event's name, venue, and core details."}
            {stage === "schedule" && "When is it happening?"}
            {stage === "vendor" && "Details vendors need to decide whether to apply."}
            {stage === "review" && "Review everything, then submit for approval."}
          </p>
        </CardHeader>
        <CardContent className="space-y-6">
          {stageError && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">
              {stageError}
            </div>
          )}
          {submitError && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">
              {submitError}
            </div>
          )}

          {stage === "basics" && (
            <div className="space-y-4">
              <Input
                label="Event Name"
                name="name"
                value={form.name}
                onChange={handleChange}
                placeholder="Summer County Fair 2026"
                required
              />
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <textarea
                  name="description"
                  value={form.description}
                  onChange={handleChange}
                  rows={4}
                  className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-gray-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy"
                  placeholder="Describe your event…"
                />
              </div>
              <VenueComboSearch
                venues={venues}
                selectedVenueId={form.venueId}
                onVenueSelect={(venueId) => {
                  setForm((prev) => ({ ...prev, venueId }));
                }}
                disabled={saving}
              />
              <Input
                label="Categories (comma-separated)"
                name="categories"
                value={form.categories}
                onChange={handleChange}
                placeholder="Fair, Festival, Food"
              />
              <Input
                label="Tags (comma-separated)"
                name="tags"
                value={form.tags}
                onChange={handleChange}
                placeholder="family-friendly, outdoor, music"
              />
              <Input
                label="Image URL"
                type="url"
                name="imageUrl"
                value={form.imageUrl}
                onChange={handleChange}
                placeholder="https://…"
              />
              {form.imageUrl && (
                <div className="aspect-video relative rounded-lg overflow-hidden bg-stone-100 border border-stone-100">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={form.imageUrl}
                    alt="Event image preview"
                    className="w-full h-full object-cover"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = "none";
                    }}
                  />
                </div>
              )}
            </div>
          )}

          {stage === "schedule" && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <input
                  id="discontinuousDates"
                  type="checkbox"
                  checked={discontinuousDates}
                  onChange={(e) => setDiscontinuousDates(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300"
                />
                <label htmlFor="discontinuousDates" className="text-sm font-normal text-gray-700">
                  Non-contiguous dates (specific dates that aren&apos;t consecutive)
                </label>
              </div>

              {!discontinuousDates && (
                <>
                  <div className="grid grid-cols-2 gap-4">
                    <Input
                      label="Start Date"
                      type="date"
                      name="startDate"
                      value={form.startDate}
                      onChange={handleChange}
                      required
                    />
                    <Input
                      label="Start Time"
                      type="time"
                      name="startTime"
                      value={form.startTime}
                      onChange={handleChange}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <Input
                      label="End Date"
                      type="date"
                      name="endDate"
                      value={form.endDate}
                      onChange={handleChange}
                      required
                    />
                    <Input
                      label="End Time"
                      type="time"
                      name="endTime"
                      value={form.endTime}
                      onChange={handleChange}
                    />
                  </div>
                </>
              )}

              <DailyScheduleInput
                startDate={startDateTimeStr}
                endDate={endDateTimeStr}
                initialDays={eventDays}
                discontinuousDates={discontinuousDates}
                onDiscontinuousChange={setDiscontinuousDates}
                onChange={handleDaysChange}
                disabled={saving}
              />

              <div className="border-t pt-4 mt-2">
                <h3 className="font-medium text-sm text-gray-700 mb-3">Tickets</h3>
                <div className="grid grid-cols-2 gap-4">
                  <Input
                    label="Min Ticket Price"
                    type="number"
                    name="ticketPriceMin"
                    value={form.ticketPriceMin}
                    onChange={handleChange}
                    placeholder="0"
                    min="0"
                    step="0.01"
                  />
                  <Input
                    label="Max Ticket Price"
                    type="number"
                    name="ticketPriceMax"
                    value={form.ticketPriceMax}
                    onChange={handleChange}
                    placeholder="50"
                    min="0"
                    step="0.01"
                  />
                </div>
                <div className="mt-3">
                  <Input
                    label="Ticket URL"
                    type="url"
                    name="ticketUrl"
                    value={form.ticketUrl}
                    onChange={handleChange}
                    placeholder="https://…"
                  />
                </div>
              </div>
            </div>
          )}

          {stage === "vendor" && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Min Booth Fee ($)"
                  type="number"
                  name="vendorFeeMin"
                  value={form.vendorFeeMin}
                  onChange={handleChange}
                  placeholder="0.00"
                />
                <Input
                  label="Max Booth Fee ($)"
                  type="number"
                  name="vendorFeeMax"
                  value={form.vendorFeeMax}
                  onChange={handleChange}
                  placeholder="0.00"
                />
              </div>
              <Input
                label="Fee Details"
                name="vendorFeeNotes"
                value={form.vendorFeeNotes}
                onChange={handleChange}
                placeholder='e.g., "$50 for 10x10, $75 for 10x20"'
              />
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Indoor / Outdoor
                  </label>
                  <select
                    name="indoorOutdoor"
                    value={form.indoorOutdoor}
                    onChange={handleChange}
                    className="w-full h-10 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
                  >
                    <option value="">Not specified</option>
                    <option value="INDOOR">Indoor</option>
                    <option value="OUTDOOR">Outdoor</option>
                    <option value="MIXED">Mixed</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Event Scale
                  </label>
                  <select
                    name="eventScale"
                    value={form.eventScale}
                    onChange={handleChange}
                    className="w-full h-10 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
                  >
                    <option value="">Not specified</option>
                    <option value="SMALL">Small</option>
                    <option value="MEDIUM">Medium</option>
                    <option value="LARGE">Large</option>
                    <option value="MAJOR">Major</option>
                  </select>
                </div>
              </div>
              <Input
                label="Estimated Attendance"
                type="number"
                name="estimatedAttendance"
                value={form.estimatedAttendance}
                onChange={handleChange}
                placeholder="Expected attendees"
              />
              <div className="flex items-center gap-2">
                <input
                  id="walkInsAllowed"
                  name="walkInsAllowed"
                  type="checkbox"
                  checked={form.walkInsAllowed}
                  onChange={handleChange}
                  className="h-4 w-4 rounded border-gray-300"
                />
                <label htmlFor="walkInsAllowed" className="text-sm text-gray-700">
                  Walk-in vendors accepted
                </label>
              </div>

              <div className="border-t pt-4 mt-2">
                <h3 className="font-medium text-sm text-gray-700 mb-3">Vendor Application</h3>
                <Input
                  label="Application Deadline"
                  type="date"
                  name="applicationDeadline"
                  value={form.applicationDeadline}
                  onChange={handleChange}
                />
                <div className="mt-3">
                  <Input
                    label="Application URL"
                    type="url"
                    name="applicationUrl"
                    value={form.applicationUrl}
                    onChange={handleChange}
                    placeholder="https://example.com/apply"
                  />
                </div>
                <div className="mt-3">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Application Instructions
                  </label>
                  <textarea
                    name="applicationInstructions"
                    value={form.applicationInstructions}
                    onChange={handleChange}
                    rows={3}
                    className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
                    placeholder="How to apply, requirements, contact info…"
                  />
                </div>
              </div>
            </div>
          )}

          {stage === "review" && (
            <ReviewBlock
              form={form}
              eventDays={eventDays}
              discontinuousDates={discontinuousDates}
              venueName={selectedVenue?.name ?? null}
            />
          )}

          <div className="flex items-center justify-between pt-4 border-t">
            <Button type="button" variant="outline" onClick={goBack} disabled={stageIndex === 0}>
              <ArrowLeft className="w-4 h-4 mr-1" />
              Back
            </Button>
            {stage === "review" ? (
              <Button
                type="button"
                onClick={handleFinalSubmit}
                isLoading={submitting}
                disabled={submitting}
              >
                <CheckCircle2 className="w-4 h-4 mr-1" />
                Submit for approval
              </Button>
            ) : (
              <Button type="button" onClick={goNext} disabled={saving}>
                {saving ? "Saving…" : "Next"}
                <ArrowRight className="w-4 h-4 ml-1" />
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ReviewBlock({
  form,
  eventDays,
  discontinuousDates,
  venueName,
}: {
  form: FormState;
  eventDays: EventDayInput[];
  discontinuousDates: boolean;
  venueName: string | null;
}) {
  const dateLine = discontinuousDates
    ? eventDays.length > 0
      ? `${eventDays.length} dates (${eventDays.map((d) => d.date).sort()[0]} to ${
          eventDays
            .map((d) => d.date)
            .sort()
            .slice(-1)[0]
        })`
      : "No dates set"
    : form.startDate && form.endDate
      ? `${form.startDate} → ${form.endDate}`
      : "No dates set";

  const feeLine =
    form.vendorFeeMin || form.vendorFeeMax
      ? `$${form.vendorFeeMin || "0"}${form.vendorFeeMax && form.vendorFeeMax !== form.vendorFeeMin ? `–$${form.vendorFeeMax}` : ""}`
      : "Not set";

  return (
    <div className="space-y-5">
      <section>
        <h4 className="text-xs uppercase tracking-wide font-semibold text-stone-600 mb-2">
          Basics
        </h4>
        <div className="rounded-lg border border-stone-100 p-4 space-y-2 text-sm">
          <p>
            <strong>{form.name || "(unnamed event)"}</strong>
          </p>
          {form.description && <p className="text-stone-600">{form.description}</p>}
          {venueName && (
            <p className="flex items-center gap-2 text-stone-900">
              <MapPin className="w-4 h-4 text-stone-600" aria-hidden />
              {venueName}
            </p>
          )}
          {form.imageUrl && (
            <div className="mt-2 relative aspect-video rounded overflow-hidden bg-stone-100 max-w-xs">
              <Image
                src={form.imageUrl}
                alt="Event image"
                fill
                sizes="320px"
                className="object-cover"
              />
            </div>
          )}
        </div>
      </section>

      <section>
        <h4 className="text-xs uppercase tracking-wide font-semibold text-stone-600 mb-2">
          Schedule
        </h4>
        <div className="rounded-lg border border-stone-100 p-4 space-y-1 text-sm">
          <p className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-stone-600" aria-hidden />
            {dateLine}
          </p>
          {(form.ticketPriceMin || form.ticketPriceMax || form.ticketUrl) && (
            <p className="flex items-center gap-2">
              <DollarSign className="w-4 h-4 text-stone-600" aria-hidden />
              Tickets: ${form.ticketPriceMin || "0"}
              {form.ticketPriceMax && form.ticketPriceMax !== form.ticketPriceMin
                ? `–$${form.ticketPriceMax}`
                : ""}
              {form.ticketUrl && (
                <a
                  href={form.ticketUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-navy hover:underline inline-flex items-center gap-0.5"
                >
                  link <ExternalLink className="w-3 h-3" aria-hidden />
                </a>
              )}
            </p>
          )}
        </div>
      </section>

      <section>
        <h4 className="text-xs uppercase tracking-wide font-semibold text-stone-600 mb-2">
          Vendor info
        </h4>
        <div className="rounded-lg border border-stone-100 p-4 space-y-1 text-sm">
          <p className="flex items-center gap-2">
            <DollarSign className="w-4 h-4 text-stone-600" aria-hidden />
            Booth fee: {feeLine}
          </p>
          {form.indoorOutdoor && (
            <p className="flex items-center gap-2">
              <Cloud className="w-4 h-4 text-stone-600" aria-hidden />
              {form.indoorOutdoor.charAt(0) + form.indoorOutdoor.slice(1).toLowerCase()}
            </p>
          )}
          {form.applicationDeadline && (
            <p className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-stone-600" aria-hidden />
              Applications close {form.applicationDeadline}
            </p>
          )}
        </div>
      </section>

      <p className="text-sm text-stone-600">
        Your event will be reviewed by our team after you submit. You&apos;ll get an email when
        it&apos;s approved.
      </p>
    </div>
  );
}

export default function CreateEventPage() {
  return (
    <Suspense fallback={<div className="p-8 text-stone-600">Loading…</div>}>
      <CreateEventWizard />
    </Suspense>
  );
}
