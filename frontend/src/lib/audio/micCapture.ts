/** Mic constraints tuned for vocal pitch analysis (minimal WebRTC processing). */
export const VOCAL_MIC_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: true,
};

/**
 * Mic constraints for the LiveKit uplink sent to the agent.
 * Echo cancellation is REQUIRED here: otherwise the mic picks up the backing
 * track and the agent's own TTS through the speakers, and the realtime model
 * hears itself, barges in on itself, and gets stuck in a feedback loop.
 */
export const AGENT_UPLINK_MIC_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

export async function captureVocalMicStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({ audio: VOCAL_MIC_CONSTRAINTS });
}

/** Separate, echo-cancelled capture used only for the agent uplink. */
export async function captureUplinkMicStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: AGENT_UPLINK_MIC_CONSTRAINTS,
  });
}
