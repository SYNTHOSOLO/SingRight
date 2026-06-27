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
  const { fftSize = DEFAULT_FFT_SIZE, onMetricsUpdate } = options;

  const [isActive, setIsActive] = useState(false);
  const [analyserNode, setAnalyserNode] = useState<AnalyserNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<VocalMetrics>(EMPTY_METRICS);

  const callbackRef = useRef(onMetricsUpdate);
  callbackRef.current = onMetricsUpdate;

  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
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

    let sumSq = 0;
    for (let i = 0; i < bufferLength; i++) {
      sumSq += timeDomain[i] * timeDomain[i];
    }
    const rms = Math.sqrt(sumSq / bufferLength);
    const volumeDb = rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100;

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
          stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: false,
            },
          });
        }

        const audioCtx = new AudioContext();
        await audioCtx.resume();

        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = fftSize;
        analyser.smoothingTimeConstant = 0.2;
        source.connect(analyser);

        audioCtxRef.current = audioCtx;
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
    [isActive, fftSize, tick]
  );

  const stop = useCallback(() => {
    cancelAnimationFrame(rafIdRef.current);
    sourceRef.current?.disconnect();
    analyserRef.current?.disconnect();

    if (ownsStreamRef.current) {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    }

    audioCtxRef.current?.close();

    audioCtxRef.current = null;
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
