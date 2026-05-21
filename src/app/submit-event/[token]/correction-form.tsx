"use client";

/**
 * Client-side form for the B4 correction flow. Server component
 * src/app/submit-event/[token]/page.tsx renders this with the event's
 * current values; on submit it POSTs to /api/submit-event/<token>.
 *
 * Kept deliberately plain (no UI library, no React Hook Form) — the
 * form has 7 fields, lives behind a one-time token URL, and doesn't
 * need to share patterns with admin pages. A bespoke fetch + useState
 * pair is right-sized.
 */

import { useState } from "react";

interface InitialValues {
  name: string;
  description: string;
  startDate: string;
  endDate: string;
  stateCode: string;
  ticketUrl: string;
  imageUrl: string;
}

interface CorrectionFormProps {
  token: string;
  initial: InitialValues;
}

type SubmitState = "idle" | "submitting" | "success" | "error";

const STATE_CODES = ["", "CT", "MA", "ME", "NH", "RI", "VT"];

export function CorrectionForm({ token, initial }: CorrectionFormProps) {
  const [values, setValues] = useState(initial);
  const [state, setState] = useState<SubmitState>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleChange =
    (field: keyof InitialValues) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      setValues((v) => ({ ...v, [field]: e.target.value }));
    };

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setState("submitting");
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/submit-event/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setState("success");
    } catch (err) {
      setState("error");
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }

  if (state === "success") {
    return (
      <div className="mt-8 rounded-md border border-green-200 bg-green-50 p-4">
        <h2 className="text-lg font-semibold text-green-900">Thanks — your corrections are in.</h2>
        <p className="mt-2 text-green-800">
          We&apos;ve saved your updates and our team will review them shortly. You&apos;ll get a
          follow-up email when the event is approved and live on the site.
        </p>
      </div>
    );
  }

  return (
    <form className="mt-8 space-y-6" onSubmit={handleSubmit}>
      <Field label="Event name" value={values.name} onChange={handleChange("name")} required />
      <Textarea
        label="Description"
        value={values.description}
        onChange={handleChange("description")}
        rows={4}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Start date"
          value={values.startDate}
          onChange={handleChange("startDate")}
          type="date"
          required
        />
        <Field
          label="End date"
          value={values.endDate}
          onChange={handleChange("endDate")}
          type="date"
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="block text-sm font-medium text-gray-700">State</label>
          <select
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
            value={values.stateCode}
            onChange={handleChange("stateCode")}
          >
            {STATE_CODES.map((s) => (
              <option key={s} value={s}>
                {s || "— Select —"}
              </option>
            ))}
          </select>
        </div>
        <Field
          label="Ticket URL"
          value={values.ticketUrl}
          onChange={handleChange("ticketUrl")}
          type="url"
        />
      </div>
      <Field
        label="Event image URL"
        value={values.imageUrl}
        onChange={handleChange("imageUrl")}
        type="url"
      />

      {state === "error" && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          Couldn&apos;t save: {errorMsg ?? "unknown error"}
        </div>
      )}

      <button
        type="submit"
        disabled={state === "submitting"}
        className="rounded-md bg-blue-600 px-4 py-2 text-white shadow hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
      >
        {state === "submitting" ? "Saving…" : "Save corrections"}
      </button>
    </form>
  );
}

interface FieldProps {
  label: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  type?: string;
  required?: boolean;
}

function Field({ label, value, onChange, type = "text", required = false }: FieldProps) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700">{label}</label>
      <input
        type={type}
        value={value}
        onChange={onChange}
        required={required}
        className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
      />
    </div>
  );
}

interface TextareaProps {
  label: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  rows?: number;
}

function Textarea({ label, value, onChange, rows = 3 }: TextareaProps) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700">{label}</label>
      <textarea
        value={value}
        onChange={onChange}
        rows={rows}
        className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
      />
    </div>
  );
}
