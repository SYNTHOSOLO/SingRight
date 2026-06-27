"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { detectPitchYin } from "@/lib/audio/pitchDetection";

export interface VocalMetrics {
  volumeDb: number;
  frequencyHz: number;
  pitchConfidence: number;
  clarity: number;
  isVoiced: boolean;
  noteName: string;
}

export interface UseVocalAnalyzerOptions {
  fftSize?: number;
  /** Pre-analyser gain — compensates for quiet LiveKit / browser mic levels. */
  analysisGain?: number;
  onMetricsUpdate?: (metrics: VocalMetrics) => void;
}

export interface UseVocalAnalyzerReturn {
  isActive: boolean;
  metrics: VocalMetrics;
  analyserNode: AnalyserNode | null;
  error: string | null;
  start: (externalStream?: MediaStream) => Promise<void>;
  stop: () => void;
}

const DEFAULT_FFT_SIZE = 2048;
const DEFAULT_ANALYSIS_GAIN = 3;

function measureVolumeDb(samples: Float32Array): number {
  let sumSq = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    sumSq += v * v;
    const abs = Math.abs(v);
    if (abs > peak) peak = abs;
  }
  const rms = Math.sqrt(sumSq / samples.length);
  const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -100;
  const peakDb = peak > 0 ? 20 * Math.log10(peak) : -100;
  // Peak tracks perceived loudness; RMS tracks sustained energy — blend both.
  const blended = Math.max(rmsDb, peakDb - 6);
  return Math.max(-100, blended);
}
const EMPTY_METRICS: VocalMetrics = {
  volumeDb: -100,
  frequencyHz: 0,
  pitchConfidence: 0,
  clarity: 0,
  isVoiced: false,
  noteName: "—",
};

export function useVocalAnalyzer(
  options: UseVocalAnalyzerOptions = {}
): UseVocalAnalyzerReturn {
  const {
    fftSize = DEFAULT_FFT_SIZE,
    analysisGain = DEFAULT_ANALYSIS_GAIN,
    onMetricsUpdate,
  } = options;

  const [isActive, setIsActive] = useState(false);
  const [analyserNode, setAnalyserNode] = useState<AnalyserNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<VocalMetrics>(EMPTY_METRICS);

  const callbackRef = useRef(onMetricsUpdate);
  callbackRef.current = onMetricsUpdate;

  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const ownsStreamRef = useRef(false);
  const rafIdRef = useRef<number>(0);

  const tick = useCallback(() => {
    const analyser = analyserRef.current;
    const audioCtx = audioCtxRef.current;
    if (!analyser || !audioCtx) return;

    const bufferLength = analyser.fftSize;
    const timeDomain = new Float32Array(bufferLength);
    analyser.getFloatTimeDomainData(timeDomain);

    const volumeDb = measureVolumeDb(timeDomain);
    const pitch = detectPitchYin(timeDomain, audioCtx.sampleRate);

    const snapshot: VocalMetrics = {
      volumeDb: Math.round(volumeDb * 10) / 10,
      frequencyHz: pitch.frequencyHz,
      pitchConfidence: pitch.confidence,
      clarity: pitch.clarity,
      isVoiced: pitch.isVoiced,
      noteName: pitch.noteName,
    };

    callbackRef.current?.(snapshot);
    rafIdRef.current = requestAnimationFrame(tick);
  }, []);

  const start = useCallback(
    async (externalStream?: MediaStream) => {
      if (isActive) return;
      setError(null);

      try {
        let stream = externalStream ?? null;
        ownsStreamRef.current = !stream;

        if (!stream) {
          const { captureVocalMicStream } = await import("@/lib/audio/micCapture");
          stream = await captureVocalMicStream();
        }

        const audioCtx = new AudioContext();
        await audioCtx.resume();

        const source = audioCtx.createMediaStreamSource(stream);
        const gain = audioCtx.createGain();
        gain.gain.value = analysisGain;
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = fftSize;
        analyser.smoothingTimeConstant = 0.05;
        source.connect(gain);
        gain.connect(analyser);

        audioCtxRef.current = audioCtx;
        gainRef.current = gain;
        analyserRef.current = analyser;
        sourceRef.current = source;
        streamRef.current = stream;
        setAnalyserNode(analyser);

        setIsActive(true);
        rafIdRef.current = requestAnimationFrame(tick);
      } catch (err) {
        const message =
          err instanceof DOMException && err.name === "NotAllowedError"
            ? "Microphone access denied. Please allow mic permissions and try again."
            : err instanceof Error
            ? err.message
            : "Failed to start microphone capture.";
        setError(message);
        throw err;
      }
    },
    [isActive, fftSize, analysisGain, tick]
  );

  const stop = useCallback(() => {
    cancelAnimationFrame(rafIdRef.current);
    sourceRef.current?.disconnect();
    gainRef.current?.disconnect();
    analyserRef.current?.disconnect();

    if (ownsStreamRef.current) {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    }

    audioCtxRef.current?.close();

    audioCtxRef.current = null;
    gainRef.current = null;
    analyserRef.current = null;
    sourceRef.current = null;
    streamRef.current = null;
    ownsStreamRef.current = false;
    setAnalyserNode(null);

    setIsActive(false);
    setMetrics(EMPTY_METRICS);
  }, []);

  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafIdRef.current);
      if (ownsStreamRef.current) {
        streamRef.current?.getTracks().forEach((t) => t.stop());
      }
      audioCtxRef.current?.close();
    };
  }, []);

  return { isActive, metrics, analyserNode, error, start, stop };
}
