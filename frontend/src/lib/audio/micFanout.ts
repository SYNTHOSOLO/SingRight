export interface MicFanoutHandle {
  analyzerStream: MediaStream;
  uplinkStream: MediaStream;
  setUplinkMuted: (muted: boolean) => void;
  dispose: () => void;
}

/**
 * Bundle the two independent mic captures:
 * - analyzer: raw, no echo cancellation — accurate local pitch/volume analysis.
 * - uplink: echo-cancelled capture sent to LiveKit so the agent does NOT hear
 *   the backing track or its own voice. The uplink can additionally be hard-muted
 *   (track.enabled = false) while the coach plays reference tones.
 *
 * The analyzer stream's tracks are owned by the caller; dispose() only stops the
 * uplink capture it manages here.
 */
export function createMicFanout(
  analyzerStream: MediaStream,
  uplinkStream: MediaStream
): MicFanoutHandle {
  const uplinkTrack = uplinkStream.getAudioTracks()[0] ?? null;

  return {
    analyzerStream,
    uplinkStream,
    setUplinkMuted(muted: boolean) {
      if (uplinkTrack) uplinkTrack.enabled = !muted;
    },
    dispose() {
      uplinkStream.getTracks().forEach((t) => t.stop());
    },
  };
}
