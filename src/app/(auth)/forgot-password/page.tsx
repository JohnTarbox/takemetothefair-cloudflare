"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setIsLoading(true);
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        if (res.status === 429) {
          setError("Too many requests. Please try again in an hour.");
        } else {
          setError("Something went wrong. Please try again.");
        }
        return;
      }
      setSubmitted(true);
    } catch {
      setError("Network error. Please check your connection and try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-[80vh] flex items-center justify-center px-4 py-12">
      <Card className="w-full max-w-md">
        <CardHeader>
          <h1 className="text-2xl font-bold text-center text-gray-900">Reset your password</h1>
          <p className="text-center text-gray-600 mt-2">
            Enter the email on your account and we&apos;ll send you a reset link.
          </p>
        </CardHeader>
        <CardContent>
          {submitted ? (
            <div className="space-y-4">
              <div className="p-4 bg-sage-50 border border-sage-50 rounded-lg text-sage-700 text-sm">
                If an account exists for <strong>{email}</strong>, a password reset link has been
                sent. Check your inbox (and spam folder). The link expires in 1 hour.
              </div>
              <Link href="/login" className="block text-center text-sm text-navy hover:underline">
                Back to sign in
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">
                  {error}
                </div>
              )}
              <Input
                label="Email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                autoFocus
              />
              <Button
                type="submit"
                className="w-full"
                isLoading={isLoading}
                disabled={isLoading || !email}
              >
                Send reset link
              </Button>
              <p className="text-center text-sm text-gray-600">
                Remembered it?{" "}
                <Link href="/login" className="text-navy hover:underline font-medium">
                  Sign in
                </Link>
              </p>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
