"use client";

import React, { useEffect, useState } from "react";
import LiveKitProvider from "@/components/LiveKitProvider";
import VocalDashboard from "@/components/VocalDashboard";
import { Headphones, Loader2, ArrowRight } from "lucide-react";

// ---------------------------------------------------------------------------
// In production, you would fetch a token from your own backend endpoint.
// This page reads from env vars for development convenience.
// ---------------------------------------------------------------------------

const LIVEKIT_URL = process.env.NEXT_PUBLIC_LIVEKIT_URL ?? "";

/**
 * Root page — handles the connect-flow UX:
 * 1. User enters (or auto-reads) the LiveKit token + server URL.
 * 2. On connect, the LiveKitProvider wraps the VocalDashboard.
 */
export default function HomePage() {
  const [serverUrl, setServerUrl] = useState(LIVEKIT_URL);
  const [token, setToken] = useState("");
  const [isJoined, setIsJoined] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  // Auto-read token from URL search params (e.g. ?token=xxx)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const t = params.get("token");
    if (t) setToken(t);
    const s = params.get("serverUrl");
    if (s) setServerUrl(s);
  }, []);

  const handleJoin = async () => {
    if (!serverUrl.trim()) {
      setError("Server URL is required");
      return;
    }
    setIsLoading(true);
    setError("");

    let activeToken = token.trim();

    // If no token is provided in the input, auto-generate one from our API route
    if (!activeToken) {
      try {
        const res = await fetch(`/api/token?room=coaching-room`);
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "Failed to generate token");
        }
        const data = await res.json();
        activeToken = data.token;
        setToken(activeToken);
      } catch (err: any) {
        setError(err.message || "Failed to fetch access token from backend api route");
        setIsLoading(false);
        return;
      }
    }

    setIsJoined(true);
    setIsLoading(false);
  };

  // ── Connected: render the dashboard inside the LiveKit room ─────────
  if (isJoined) {
    return (
      <LiveKitProvider token={token} serverUrl={serverUrl}>
        <VocalDashboard />
      </LiveKitProvider>
    );
  }

  // ── Pre-join screen ─────────────────────────────────────────────────
  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="glass-card glow-violet w-full max-w-md p-8">
        {/* Logo / brand */}
        <div className="mb-8 flex flex-col items-center gap-3">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-600 to-fuchsia-600 shadow-lg shadow-violet-600/30">
            <Headphones className="h-7 w-7 text-white" />
          </div>
          <h1 className="text-2xl font-extrabold tracking-tight text-white">
            AI Vocal Coach
          </h1>
          <p className="text-center text-sm text-[var(--color-text-muted)]">
            Connect to your LiveKit room to begin a real-time coaching session.
          </p>
        </div>

        {/* Error Display */}
        {error && (
          <div className="mb-6 rounded-lg bg-rose-500/10 border border-rose-500/25 p-3 text-center text-xs font-semibold text-rose-400">
            {error}
          </div>
        )}

        {/* Form */}
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-[var(--color-text-secondary)]">
              LiveKit Server URL
            </span>
            <input
              type="text"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="wss://your-server.livekit.cloud"
              className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-secondary)] px-4 py-2.5 text-sm text-white placeholder:text-[var(--color-text-muted)] focus:border-violet-500/50 focus:outline-none focus:ring-1 focus:ring-violet-500/30"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <div className="flex justify-between items-center">
              <span className="text-xs font-medium text-[var(--color-text-secondary)]">
                Access Token
              </span>
              <span className="text-[10px] text-[var(--color-text-muted)] italic">
                Optional (auto-generated if empty)
              </span>
            </div>
            <input
              type="text"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Leave empty to auto-generate"
              className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-secondary)] px-4 py-2.5 text-sm text-white placeholder:text-[var(--color-text-muted)] focus:border-violet-500/50 focus:outline-none focus:ring-1 focus:ring-violet-500/30"
            />
          </label>

          <button
            onClick={handleJoin}
            disabled={!serverUrl.trim() || isLoading}
            className="group mt-2 flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 px-6 py-3 text-sm font-bold text-white shadow-lg shadow-violet-600/20 transition-all duration-300 hover:shadow-xl hover:shadow-violet-600/30 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isLoading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Connecting…
              </>
            ) : (
              <>
                Join Session
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </>
            )}
          </button>
        </div>

        {/* Help text */}
        <p className="mt-6 text-center text-xs leading-relaxed text-[var(--color-text-muted)]">
          Generate a token via the{" "}
          <code className="rounded bg-white/5 px-1 py-0.5 text-violet-400">
            livekit-cli
          </code>{" "}
          or your server&apos;s token endpoint. You can also pass{" "}
          <code className="rounded bg-white/5 px-1 py-0.5 text-violet-400">
            ?token=…&amp;serverUrl=…
          </code>{" "}
          as URL params.
        </p>
      </div>
    </div>
  );
}
