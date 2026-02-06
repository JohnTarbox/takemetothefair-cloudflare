"use client";

import { Suspense, useState, useCallback, useRef, useEffect } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import Script from "next/script";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

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

export const runtime = "edge";

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
  const [isLoading, setIsLoading] = useState(false);

  // Turnstile state
  const [turnstileToken, setTurnstileToken] = useState<string>("");
  const [turnstileReady, setTurnstileReady] = useState(false);
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

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) => {
    setFormData((prev) => ({
      ...prev,
      [e.target.name]: e.target.value,
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (formData.password !== formData.confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    if (formData.role === "PROMOTER" && !formData.companyName) {
      setError("Company name is required for promoters");
      return;
    }

    if (formData.role === "VENDOR" && !formData.businessName) {
      setError("Business name is required for vendors");
      return;
    }

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

      const data = await response.json() as { error?: string; retryAfter?: number };

      if (!response.ok) {
        // Handle rate limiting
        if (response.status === 429 && data.retryAfter) {
          const minutes = Math.ceil(data.retryAfter / 60);
          setError(`Too many attempts. Please try again in ${minutes} minute${minutes > 1 ? "s" : ""}.`);
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
        router.push("/dashboard");
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
        <h1 className="text-2xl font-bold text-center text-gray-900">
          Create an Account
        </h1>
        <p className="text-center text-gray-600 mt-2">Join Meet Me at the Fair</p>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">
              {error}
            </div>
          )}

          <Input
            label="Full Name"
            name="name"
            value={formData.name}
            onChange={handleChange}
            placeholder="John Doe"
            required
          />

          <Input
            label="Email"
            type="email"
            name="email"
            value={formData.email}
            onChange={handleChange}
            placeholder="you@example.com"
            required
          />

          <Input
            label="Password"
            type="password"
            name="password"
            value={formData.password}
            onChange={handleChange}
            placeholder="At least 8 characters"
            required
          />

          <Input
            label="Confirm Password"
            type="password"
            name="confirmPassword"
            value={formData.confirmPassword}
            onChange={handleChange}
            placeholder="Confirm your password"
            required
          />

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              I am a...
            </label>
            <select
              name="role"
              value={formData.role}
              onChange={handleChange}
              className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
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
              placeholder="Your business name"
              required
            />
          )}

          <Button
            type="submit"
            className="w-full"
            isLoading={isLoading}
            disabled={isLoading}
          >
            Create Account
          </Button>
        </form>

        <p className="mt-6 text-center text-sm text-gray-600">
          Already have an account?{" "}
          <Link
            href="/login"
            className="text-blue-600 hover:text-blue-700 font-medium"
          >
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
