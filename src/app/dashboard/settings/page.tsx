"use client";

import { useState, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { getShortErrorMessage } from "@/lib/error-messages";
import { Copy, Trash2, Plus, Key } from "lucide-react";

export const runtime = "edge";

interface ApiToken {
  id: string;
  name: string;
  lastUsedAt: string | null;
  createdAt: string | null;
}

export default function SettingsPage() {
  const { data: session, update } = useSession();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [formData, setFormData] = useState({
    name: session?.user?.name || "",
  });

  // API Token state
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [tokensLoading, setTokensLoading] = useState(false);
  const [newTokenName, setNewTokenName] = useState("");
  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  const [tokenMessage, setTokenMessage] = useState("");
  const [copied, setCopied] = useState(false);

  const fetchTokens = useCallback(async () => {
    try {
      const res = await fetch("/api/user/api-tokens");
      if (res.ok) {
        setTokens(await res.json());
      }
    } catch {
      // Silently fail — tokens section just won't load
    }
  }, []);

  useEffect(() => {
    if (session?.user?.id) {
      fetchTokens();
    }
  }, [session?.user?.id, fetchTokens]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData((prev) => ({
      ...prev,
      [e.target.name]: e.target.value,
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage("");

    try {
      const res = await fetch("/api/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });

      if (res.ok) {
        await update({ name: formData.name });
        setMessage("Profile updated successfully");
      } else {
        setMessage(getShortErrorMessage(res, "update your profile"));
      }
    } catch (err) {
      setMessage(getShortErrorMessage(err, "update your profile"));
    } finally {
      setLoading(false);
    }
  };

  const handleCreateToken = async () => {
    setTokensLoading(true);
    setTokenMessage("");
    setRevealedToken(null);

    try {
      const res = await fetch("/api/user/api-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newTokenName || "Default" }),
      });

      if (res.ok) {
        const data = (await res.json()) as { token: string };
        setRevealedToken(data.token);
        setNewTokenName("");
        await fetchTokens();
      } else {
        const data = (await res.json()) as { error?: string };
        setTokenMessage(data.error || "Failed to create token");
      }
    } catch {
      setTokenMessage("Failed to create token");
    } finally {
      setTokensLoading(false);
    }
  };

  const handleRevokeToken = async (id: string) => {
    try {
      await fetch(`/api/user/api-tokens?id=${id}`, { method: "DELETE" });
      setTokens((prev) => prev.filter((t) => t.id !== id));
    } catch {
      setTokenMessage("Failed to revoke token");
    }
  };

  const handleCopyToken = async () => {
    if (!revealedToken) return;
    await navigator.clipboard.writeText(revealedToken);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!session) {
    return null;
  }

  return (
    <div className="mx-auto max-w-2xl px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-8">Account Settings</h1>

      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold text-gray-900">Profile</h2>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {message && (
              <div
                className={`p-3 rounded-lg text-sm ${
                  message.includes("success")
                    ? "bg-green-50 text-green-700"
                    : "bg-red-50 text-red-600"
                }`}
              >
                {message}
              </div>
            )}

            <Input
              label="Email"
              type="email"
              value={session.user.email}
              disabled
            />

            <Input
              label="Name"
              name="name"
              value={formData.name}
              onChange={handleChange}
              placeholder="Your name"
            />

            <Button type="submit" isLoading={loading} disabled={loading}>
              Save Changes
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <h2 className="text-lg font-semibold text-gray-900">
            Account Information
          </h2>
        </CardHeader>
        <CardContent>
          <div className="space-y-3 text-sm">
            <div>
              <span className="text-gray-500">Account Type:</span>{" "}
              <span className="font-medium capitalize">
                {session.user.role.toLowerCase()}
              </span>
            </div>
            <div>
              <span className="text-gray-500">User ID:</span>{" "}
              <span className="font-mono text-xs">{session.user.id}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* API Tokens Section */}
      <Card className="mt-6">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Key className="h-5 w-5 text-gray-500" />
            <h2 className="text-lg font-semibold text-gray-900">API Tokens</h2>
          </div>
          <p className="text-sm text-gray-500 mt-1">
            Generate tokens to connect external tools like Claude Cowork to your account.
          </p>
        </CardHeader>
        <CardContent>
          {tokenMessage && (
            <div className="p-3 rounded-lg text-sm bg-red-50 text-red-600 mb-4">
              {tokenMessage}
            </div>
          )}

          {/* Revealed token banner */}
          {revealedToken && (
            <div className="p-4 rounded-lg bg-amber-50 border border-amber-200 mb-4">
              <p className="text-sm font-medium text-amber-800 mb-2">
                Copy your token now — it won&apos;t be shown again.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 bg-white px-3 py-2 rounded border text-xs font-mono break-all">
                  {revealedToken}
                </code>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleCopyToken}
                >
                  <Copy className="h-4 w-4" />
                  <span className="ml-1">{copied ? "Copied" : "Copy"}</span>
                </Button>
              </div>
            </div>
          )}

          {/* Create new token */}
          <div className="flex items-end gap-2 mb-6">
            <div className="flex-1">
              <Input
                label="Token Name"
                value={newTokenName}
                onChange={(e) => setNewTokenName(e.target.value)}
                placeholder="e.g. Claude Cowork"
              />
            </div>
            <Button
              type="button"
              onClick={handleCreateToken}
              disabled={tokensLoading}
              isLoading={tokensLoading}
              size="md"
            >
              <Plus className="h-4 w-4 mr-1" />
              Generate
            </Button>
          </div>

          {/* Token list */}
          {tokens.length === 0 ? (
            <p className="text-sm text-gray-500">No API tokens yet.</p>
          ) : (
            <div className="divide-y">
              {tokens.map((token) => (
                <div key={token.id} className="py-3 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-900">{token.name}</p>
                    <p className="text-xs text-gray-500">
                      Created{" "}
                      {token.createdAt
                        ? new Date(token.createdAt).toLocaleDateString()
                        : "unknown"}
                      {token.lastUsedAt && (
                        <>
                          {" "}· Last used{" "}
                          {new Date(token.lastUsedAt).toLocaleDateString()}
                        </>
                      )}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRevokeToken(token.id)}
                    className="text-red-600 hover:text-red-700 hover:bg-red-50"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
