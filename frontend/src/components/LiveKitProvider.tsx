"use client";

import React from "react";
import { LiveKitRoom, RoomAudioRenderer } from "@livekit/components-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LiveKitProviderProps {
  token: string;
  serverUrl: string;
  children: React.ReactNode;
}

// ---------------------------------------------------------------------------
// Provider Component
// ---------------------------------------------------------------------------

/**
 * Wraps children in a `<LiveKitRoom>` that connects to the given server
 * using the provided auth token. Renders the invisible `<RoomAudioRenderer>`
 * so that agent audio is played automatically.
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
      audio={false}
      video={false}
      data-lk-theme="default"
      className="min-h-dvh"
    >
      <RoomAudioRenderer />
      {children}
    </LiveKitRoom>
  );
}
