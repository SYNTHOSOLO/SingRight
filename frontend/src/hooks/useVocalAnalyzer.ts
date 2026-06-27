"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VocalMetrics {
  /** Volume in decibels (typically -100 … 0). */
  volumeDb: number;
  /** Estimated fundamental frequency in Hz (0 when undetectable). */
  frequencyHz: number;
}

export interface UseVocalAnalyzerOptions {
  /** FFT size for the AnalyserNode (must be a power of 2). Default 2048. */
  fftSize?: number;
  /** Minimum RMS threshold below which pitch detection is skipped. */
  silenceThreshold?: number;
  /** Called on every animation frame with the latest metrics. */
  onMetricsUpdate?: (metrics: VocalMetrics) => void;
}

export interface UseVocalAnalyzerReturn {
  /** Whether the mic stream is active. */
  isActive: boolean;
  /** Latest computed metrics snapshot. */
  metrics: VocalMetrics;
  /** Start mic capture & analysis. */
  start: () => Promise<void>;
  /** Stop mic capture & analysis. */
  stop: () => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_FFT_SIZE = 2048;
const DEFAULT_SILENCE_THRESHOLD = 0.01;
const MIN_DETECTABLE_HZ = 60;
const MAX_DETECTABLE_HZ = 1200;

// ---------------------------------------------------------------------------
// Autocorrelation Pitch Detector
// ---------------------------------------------------------------------------

/**
 * Basic autocorrelation-based pitch detector.
 * Operates on a time-domain float buffer from the AnalyserNode.
 * Returns the estimated fundamental frequency in Hz, or 0 if no clear
 * pitch is detected.
 */
function detectPitchAutocorrelation(
  buffer: Float32Array,
  sampleRate: number,
  silenceThreshold: number
): number {
  const n = buffer.length;

  // ── RMS gate: skip pitch detection if the signal is too quiet ──────
  let rms = 0;
  for (let i = 0; i < n; i++) {
    rms += buffer[i] * buffer[i];
  }
  rms = Math.sqrt(rms / n);
  if (rms < silenceThreshold) return 0;

  // ── Normalise ─────────────────────────────────────────────────────
  const normalised = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    normalised[i] = buffer[i];
  }

  // ── Trim leading/trailing near-silence for cleaner autocorrelation ─
  let trimStart = 0;
  let trimEnd = n - 1;
  const trimThreshold = 0.2;
  while (trimStart < n && Math.abs(normalised[trimStart]) < trimThreshold) {
    trimStart++;
  }
  while (trimEnd > 0 && Math.abs(normalised[trimEnd]) < trimThreshold) {
    trimEnd--;
  }
  if (trimEnd - trimStart < 2) return 0;

  const trimmed = normalised.subarray(trimStart, trimEnd + 1);
  const len = trimmed.length;

  // ── Autocorrelation ────────────────────────────────────────────────
  const minLag = Math.floor(sampleRate / MAX_DETECTABLE_HZ);
  const maxLag = Math.floor(sampleRate / MIN_DETECTABLE_HZ);

  let bestCorrelation = 0;
  let bestLag = -1;

  for (let lag = minLag; lag <= Math.min(maxLag, len - 1); lag++) {
    let correlation = 0;
    for (let i = 0; i < len - lag; i++) {
      correlation += trimmed[i] * trimmed[i + lag];
    }
    // Normalise by overlap length
    correlation /= len - lag;

    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestLag = lag;
    }
  }

  // Require a minimum correlation confidence
  if (bestLag === -1 || bestCorrelation < 0.01) return 0;

  // ── Parabolic interpolation for sub-sample accuracy ────────────────
  let refinedLag = bestLag;
  if (bestLag > minLag && bestLag < Math.min(maxLag, len - 1)) {
    const corrPrev = (() => {
      let c = 0;
      for (let i = 0; i < len - (bestLag - 1); i++) {
        c += trimmed[i] * trimmed[i + bestLag - 1];
      }
      return c / (len - bestLag + 1);
    })();
    const corrNext = (() => {
      let c = 0;
      for (let i = 0; i < len - (bestLag + 1); i++) {
        c += trimmed[i] * trimmed[i + bestLag + 1];
      }
      return c / (len - bestLag - 1);
    })();

    const shift = (corrPrev - corrNext) / (2 * (corrPrev - 2 * bestCorrelation + corrNext));
    if (isFinite(shift)) {
      refinedLag = bestLag + shift;
    }
  }

  const frequency = sampleRate / refinedLag;
  if (frequency < MIN_DETECTABLE_HZ || frequency > MAX_DETECTABLE_HZ) return 0;

  return Math.round(frequency * 10) / 10;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useVocalAnalyzer(
  options: UseVocalAnalyzerOptions = {}
): UseVocalAnalyzerReturn {
  const {
    fftSize = DEFAULT_FFT_SIZE,
    silenceThreshold = DEFAULT_SILENCE_THRESHOLD,
    onMetricsUpdate,
  } = options;

  const [isActive, setIsActive] = useState(false);
  const [metrics, setMetrics] = useState<VocalMetrics>({
    volumeDb: -100,
    frequencyHz: 0,
  });

  // Stable references to avoid re-render churn
  const callbackRef = useRef(onMetricsUpdate);
  callbackRef.current = onMetricsUpdate;

  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafIdRef = useRef<number>(0);

  // ── Analysis loop ──────────────────────────────────────────────────
  const tick = useCallback(() => {
    const analyser = analyserRef.current;
    const audioCtx = audioCtxRef.current;
    if (!analyser || !audioCtx) return;

    const bufferLength = analyser.fftSize;
    const timeDomain = new Float32Array(bufferLength);
    analyser.getFloatTimeDomainData(timeDomain);

    // ── RMS → dB ─────────────────────────────────────────────────────
    let sumSq = 0;
    for (let i = 0; i < bufferLength; i++) {
      sumSq += timeDomain[i] * timeDomain[i];
    }
    const rms = Math.sqrt(sumSq / bufferLength);
    const volumeDb =
      rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100;

    // ── Pitch ────────────────────────────────────────────────────────
    const frequencyHz = detectPitchAutocorrelation(
      timeDomain,
      audioCtx.sampleRate,
      silenceThreshold
    );

    const snapshot: VocalMetrics = {
      volumeDb: Math.round(volumeDb * 10) / 10,
      frequencyHz,
    };

    setMetrics(snapshot);
    callbackRef.current?.(snapshot);

    rafIdRef.current = requestAnimationFrame(tick);
  }, [silenceThreshold]);

  // ── Start ──────────────────────────────────────────────────────────
  const start = useCallback(async () => {
    if (isActive) return;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
      },
    });

    const audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = fftSize;
    analyser.smoothingTimeConstant = 0.3;
    source.connect(analyser);

    audioCtxRef.current = audioCtx;
    analyserRef.current = analyser;
    sourceRef.current = source;
    streamRef.current = stream;

    setIsActive(true);
    rafIdRef.current = requestAnimationFrame(tick);
  }, [isActive, fftSize, tick]);

  // ── Stop ───────────────────────────────────────────────────────────
  const stop = useCallback(() => {
    cancelAnimationFrame(rafIdRef.current);
    sourceRef.current?.disconnect();
    analyserRef.current?.disconnect();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    audioCtxRef.current?.close();

    audioCtxRef.current = null;
    analyserRef.current = null;
    sourceRef.current = null;
    streamRef.current = null;

    setIsActive(false);
    setMetrics({ volumeDb: -100, frequencyHz: 0 });
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafIdRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      audioCtxRef.current?.close();
    };
  }, []);

  return { isActive, metrics, start, stop };
}
