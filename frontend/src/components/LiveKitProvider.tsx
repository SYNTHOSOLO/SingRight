"use client";

import React from "react";
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useConnectionState,
} from "@livekit/components-react";
import { ConnectionState } from "livekit-client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LiveKitProviderProps {
  token: string;
  serverUrl: string;
  children: React.ReactNode;
}

// ---------------------------------------------------------------------------
// Connection Status Badge (internal)
// ---------------------------------------------------------------------------

function ConnectionBadge() {
  const connectionState = useConnectionState();

  const label: Record<string, string> = {
    [ConnectionState.Connected]: "Connected",
    [ConnectionState.Connecting]: "Connecting…",
    [ConnectionState.Disconnected]: "Disconnected",
    [ConnectionState.Reconnecting]: "Reconnecting…",
  };

  const color: Record<string, string> = {
    [ConnectionState.Connected]:
      "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
    [ConnectionState.Connecting]:
      "bg-amber-500/20 text-amber-400 border-amber-500/30",
    [ConnectionState.Disconnected]:
      "bg-rose-500/20 text-rose-400 border-rose-500/30",
    [ConnectionState.Reconnecting]:
      "bg-amber-500/20 text-amber-400 border-amber-500/30",
  };

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${
        color[connectionState] ?? "bg-zinc-800 text-zinc-400 border-zinc-700"
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          connectionState === ConnectionState.Connected
            ? "bg-emerald-400"
            : connectionState === ConnectionState.Disconnected
            ? "bg-rose-400"
            : "bg-amber-400 animate-pulse"
        }`}
      />
      {label[connectionState] ?? "Unknown"}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Provider Component
// ---------------------------------------------------------------------------

/**
 * Wraps children in a `<LiveKitRoom>` that connects to the given server
 * using the provided auth token. Renders the invisible `<RoomAudioRenderer>`
 * so that agent audio is played automatically, and shows a connection badge.
 */
export default function LiveKitProvider({
  token,
  serverUrl,
  children,
}: LiveKitProviderProps) {
  return (
    <LiveKitRoom
      token={token}
      serverUrl={serverUrl}
      connect={true}
      audio={true}
      video={false}
      data-lk-theme="default"
      className="min-h-dvh"
    >
      {/* Invisible renderer that plays incoming agent audio tracks */}
      <RoomAudioRenderer />

      {/* Connection status */}
      <div className="fixed top-4 right-4 z-50">
        <ConnectionBadge />
      </div>

      {children}
    </LiveKitRoom>
  );
}
