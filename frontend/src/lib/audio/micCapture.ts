/** Mic constraints tuned for vocal pitch analysis (minimal WebRTC processing). */
export const VOCAL_MIC_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: true,
};

export async function captureVocalMicStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({ audio: VOCAL_MIC_CONSTRAINTS });
}
