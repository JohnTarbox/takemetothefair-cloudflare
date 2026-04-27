"use client";

import { Suspense, useState, useCallback, useRef, useEffect } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import Script from "next/script";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { FormErrorSummary } from "@/components/ui/form-error-summary";
import { trackEvent } from "@/lib/analytics";
import { type FieldErrors, validateAll, validateField } from "@/lib/validations/field-errors";

// Client-side schema mirrors the server registerSchema but adds the
// confirmPassword match check and role-specific conditionals the server
// handles separately.
const registerClientSchema = z
  .object({
    name: z.string().min(2, "Please enter your full name"),
    email: z.string().email("Please enter a valid email address"),
    password: z.string().min(8, "Password must be at least 8 characters"),
    confirmPassword: z.string(),
    role: z.enum(["USER", "PROMOTER", "VENDOR"]),
    companyName: z.string().optional(),
    businessName: z.string().optional(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  })
  .refine((data) => data.role !== "PROMOTER" || !!data.companyName?.trim(), {
    message: "Company name is required for promoters",
    path: ["companyName"],
  })
  .refine((data) => data.role !== "VENDOR" || !!data.businessName?.trim(), {
    message: "Business name is required for vendors",
    path: ["businessName"],
  });

const FIELD_LABELS: Record<string, string> = {
  name: "Full name",
  email: "Email",
  password: "Password",
  confirmPassword: "Confirm password",
  companyName: "Company name",
  businessName: "Business name",
};

// Turnstile widget types
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
  size?: "normal" | "compact" | "invisible";
  theme?: "light" | "dark" | "auto";
}

function RegisterForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const defaultRole = searchParams.get("role") || "USER";

  const [formData, setFormData] = useState({
    email: "",
    password: "",
    confirmPassword: "",
    name: "",
    role: defaultRole.toUpperCase(),
    companyName: "",
    businessName: "",
  });
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [isLoading, setIsLoading] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);

  // Turnstile state
  const [turnstileToken, setTurnstileToken] = useState<string>("");
  const [_turnstileReady, setTurnstileReady] = useState(false);
  const turnstileWidgetId = useRef<string | null>(null);
  const turnstileContainerRef = useRef<HTMLDivElement>(null);

  // Get the Turnstile site key from environment
  const turnstileSiteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

  // Initialize Turnstile widget
  const initTurnstile = useCallback(() => {
    if (!turnstileSiteKey || !window.turnstile || !turnstileContainerRef.current) {
      return;
    }

    // Remove existing widget if any
    if (turnstileWidgetId.current) {
      try {
        window.turnstile.remove(turnstileWidgetId.current);
      } catch {
        // Widget might already be removed
      }
    }

    // Render invisible Turnstile widget
    turnstileWidgetId.current = window.turnstile.render(turnstileContainerRef.current, {
      sitekey: turnstileSiteKey,
      size: "invisible",
      callback: (token: string) => {
        setTurnstileToken(token);
      },
      "expired-callback": () => {
        setTurnstileToken("");
      },
      "error-callback": () => {
        setTurnstileToken("");
      },
    });

    setTurnstileReady(true);
  }, [turnstileSiteKey]);

  // Reset Turnstile after failed submission
  const resetTurnstile = useCallback(() => {
    if (window.turnstile && turnstileWidgetId.current) {
      try {
        window.turnstile.reset(turnstileWidgetId.current);
      } catch {
        // Widget might not exist
      }
    }
    setTurnstileToken("");
  }, []);

  // Initialize Turnstile when script loads
  useEffect(() => {
    // If Turnstile is already loaded but widget not initialized
    if (window.turnstile && turnstileSiteKey && !turnstileWidgetId.current) {
      initTurnstile();
    }
  }, [initTurnstile, turnstileSiteKey]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setFormData((prev) => ({
      ...prev,
      [e.target.name]: e.target.value,
    }));
    // Clear field-level error as the user edits.
    if (fieldErrors[e.target.name]) {
      setFieldErrors((prev) => {
        const { [e.target.name]: _removed, ...rest } = prev;
        return rest;
      });
    }
  };

  const handleBlur = (e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) => {
    const field = e.target.name;
    const message = validateField(registerClientSchema, field, formData);
    setFieldErrors((prev) => {
      const next = { ...prev };
      if (message) next[field] = message;
      else delete next[field];
      return next;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    const validation = validateAll(registerClientSchema, formData);
    if (!validation.ok) {
      setFieldErrors(validation.errors);
      return;
    }
    setFieldErrors({});

    setIsLoading(true);

    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: formData.email,
          password: formData.password,
          name: formData.name,
          role: formData.role,
          companyName: formData.companyName,
          businessName: formData.businessName,
          turnstileToken: turnstileToken || undefined,
        }),
      });

      const data = (await response.json()) as { error?: string; retryAfter?: number };

      if (!response.ok) {
        // Handle rate limiting
        if (response.status === 429 && data.retryAfter) {
          const minutes = Math.ceil(data.retryAfter / 60);
          setError(
            `Too many attempts. Please try again in ${minutes} minute${minutes > 1 ? "s" : ""}.`
          );
        } else {
          setError(data.error || "Registration failed");
        }
        resetTurnstile();
        return;
      }

      const result = await signIn("credentials", {
        email: formData.email,
        password: formData.password,
        redirect: false,
      });

      if (result?.error) {
        router.push("/login");
      } else {
        trackEvent("sign_up", { category: "conversion", label: "email" });
        // Role-aware first-run: send vendors and promoters to their
        // highest-leverage setup surface instead of a generic dashboard.
        const firstRunTarget =
          formData.role === "VENDOR"
            ? "/vendor/profile?welcome=1"
            : formData.role === "PROMOTER"
              ? "/promoter/events/new?welcome=1"
              : "/dashboard?welcome=1";
        router.push(firstRunTarget);
        router.refresh();
      }
    } catch {
      setError("An error occurred. Please try again.");
      resetTurnstile();
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      {/* Turnstile Script */}
      {turnstileSiteKey && (
        <Script
          src="https://challenges.cloudflare.com/turnstile/v0/api.js"
          strategy="afterInteractive"
          onLoad={initTurnstile}
        />
      )}

      {/* Invisible Turnstile widget container */}
      <div ref={turnstileContainerRef} className="hidden" />

      <Card className="w-full max-w-md">
        <CardHeader>
          <h1 className="text-2xl font-bold text-center text-gray-900">Create an Account</h1>
          <p className="text-center text-gray-600 mt-2">Join Meet Me at the Fair</p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">
                {error}
              </div>
            )}
            <FormErrorSummary errors={fieldErrors} fieldLabels={FIELD_LABELS} />

            <Input
              label="Full Name"
              name="name"
              value={formData.name}
              onChange={handleChange}
              onBlur={handleBlur}
              error={fieldErrors.name}
              placeholder="John Doe"
              required
            />

            <Input
              label="Email"
              type="email"
              name="email"
              value={formData.email}
              onChange={handleChange}
              onBlur={handleBlur}
              error={fieldErrors.email}
              placeholder="you@example.com"
              required
            />

            <Input
              label="Password"
              type="password"
              name="password"
              value={formData.password}
              onChange={handleChange}
              onBlur={handleBlur}
              error={fieldErrors.password}
              placeholder="At least 8 characters"
              required
            />

            <Input
              label="Confirm Password"
              type="password"
              name="confirmPassword"
              value={formData.confirmPassword}
              onChange={handleChange}
              onBlur={handleBlur}
              error={fieldErrors.confirmPassword}
              placeholder="Confirm your password"
              required
            />

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">I am a...</label>
              <select
                name="role"
                value={formData.role}
                onChange={handleChange}
                className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-gray-900 focus:border-royal focus:outline-none focus:ring-1 focus:ring-royal"
              >
                <option value="USER">Event Enthusiast</option>
                <option value="PROMOTER">Event Promoter</option>
                <option value="VENDOR">Vendor</option>
              </select>
            </div>

            {formData.role === "PROMOTER" && (
              <Input
                label="Company Name"
                name="companyName"
                value={formData.companyName}
                onChange={handleChange}
                onBlur={handleBlur}
                error={fieldErrors.companyName}
                placeholder="Your company name"
                required
              />
            )}

            {formData.role === "VENDOR" && (
              <Input
                label="Business Name"
                name="businessName"
                value={formData.businessName}
                onChange={handleChange}
                onBlur={handleBlur}
                error={fieldErrors.businessName}
                placeholder="Your business name"
                required
              />
            )}

            <label className="flex items-start gap-2 text-sm text-gray-600">
              <input
                type="checkbox"
                checked={termsAccepted}
                onChange={(e) => setTermsAccepted(e.target.checked)}
                className="rounded border-gray-300 mt-0.5"
                required
              />
              <span>
                I agree to the{" "}
                <a href="/terms" target="_blank" className="text-royal hover:underline">
                  Terms of Service
                </a>{" "}
                and{" "}
                <a href="/privacy" target="_blank" className="text-royal hover:underline">
                  Privacy Policy
                </a>
              </span>
            </label>

            <Button
              type="submit"
              className="w-full"
              isLoading={isLoading}
              disabled={isLoading || !termsAccepted}
            >
              Create Account
            </Button>
          </form>

          <div className="mt-6">
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-gray-200" />
              </div>
              <div className="relative flex justify-center text-sm">
                <span className="px-2 bg-white text-gray-500">Or sign up with</span>
              </div>
            </div>

            <div className="mt-4 space-y-3">
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={() => {
                  trackEvent("sign_up", { category: "conversion", label: "google" });
                  signIn("google", { callbackUrl: "/dashboard" });
                }}
              >
                <svg className="w-5 h-5 mr-2" viewBox="0 0 24 24">
                  <path
                    fill="currentColor"
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                  />
                  <path
                    fill="currentColor"
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  />
                  <path
                    fill="currentColor"
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                  />
                  <path
                    fill="currentColor"
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                  />
                </svg>
                Continue with Google
              </Button>

              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={() => {
                  trackEvent("sign_up", { category: "conversion", label: "facebook" });
                  signIn("facebook", { callbackUrl: "/dashboard" });
                }}
              >
                <svg className="w-5 h-5 mr-2" viewBox="0 0 24 24">
                  <path
                    fill="currentColor"
                    d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"
                  />
                </svg>
                Continue with Facebook
              </Button>
            </div>
          </div>

          <p className="mt-6 text-center text-sm text-gray-600">
            Already have an account?{" "}
            <Link href="/login" className="text-royal hover:text-navy font-medium">
              Sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    </>
  );
}

export default function RegisterPage() {
  return (
    <div className="min-h-[80vh] flex items-center justify-center px-4 py-12">
      <Suspense
        fallback={
          <div className="w-full max-w-md h-[600px] bg-gray-100 rounded-xl animate-pulse" />
        }
      >
        <RegisterForm />
      </Suspense>
    </div>
  );
}
