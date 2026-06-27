"use client";

import { useEffect, useState } from "react";
import { ParticipantEvent } from "livekit-client";
import { useRemoteParticipants } from "@livekit/components-react";
import type { MicFanoutHandle } from "@/lib/audio/micFanout";

function isAgentIdentity(identity: string): boolean {
  return identity.includes("agent") || identity.startsWith("agent-");
}

export function useRemoteAgentSpeaking(): boolean {
  const participants = useRemoteParticipants();
  // The agent is the only remote participant in this app; match by identity but
  // fall back to the first remote participant so detection never silently fails.
  const agent =
    participants.find((p) => isAgentIdentity(p.identity)) ?? participants[0];
  const [speaking, setSpeaking] = useState(() => agent?.isSpeaking ?? false);

  useEffect(() => {
    if (!agent) {
      setSpeaking(false);
      return;
    }

    const sync = () => setSpeaking(agent.isSpeaking);
    sync();
    agent.on(ParticipantEvent.IsSpeakingChanged, sync);
    return () => {
      agent.off(ParticipantEvent.IsSpeakingChanged, sync);
    };
  }, [agent]);

  return speaking;
}

export interface UseMicUplinkGateOptions {
  fanout: MicFanoutHandle | null;
  coachDemonstrating: boolean;
  /**
   * Whether the agent's TTS is actually audible through the student's speakers.
   * In silent cue mode the agent's audio is muted, so there is nothing for the
   * mic to echo — the uplink must stay open so the agent keeps hearing the
   * student even while the (muted) model is "speaking".
   */
  agentAudible: boolean;
}

/**
 * Mute the LiveKit mic uplink ONLY while real speaker output could echo back
 * into the agent: an explicit tone/sample demonstration, or the agent's own
 * audible TTS. The uplink is re-enabled the instant that output stops, so the
 * agent never gets permanently deafened (e.g. after delivering feedback).
 */
export function useMicUplinkGate({
  fanout,
  coachDemonstrating,
  agentAudible,
}: UseMicUplinkGateOptions): void {
  const agentSpeaking = useRemoteAgentSpeaking();

  useEffect(() => {
    if (!fanout) return;
    const muteUplink = coachDemonstrating || (agentAudible && agentSpeaking);
    fanout.setUplinkMuted(muteUplink);
  }, [fanout, coachDemonstrating, agentAudible, agentSpeaking]);
}
