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
  micLabel: string | null;
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

// Sliding window size for smooth pitch tracking
const HISTORY_SIZE = 7;
const pitchHistoryBuffer: number[] = [];

function getSmoothedPitch(rawHz: number): number {
  if (rawHz <= 0) {
    pitchHistoryBuffer.length = 0;
    return 0;
  }

  // 1. Accumulate raw pitch values
  pitchHistoryBuffer.push(rawHz);
  if (pitchHistoryBuffer.length > HISTORY_SIZE) {
    pitchHistoryBuffer.shift();
  }

  // 2. Find the median to use as a robust baseline
  const sorted = [...pitchHistoryBuffer].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  // 3. Reject any raw point that deviates from the median by more than 3 semitones
  const diffSemitones = Math.abs(1200 * Math.log2(rawHz / median)) / 100;
  if (diffSemitones > 3) {
    // If it's a glitch, override it with the median value to keep it smooth
    pitchHistoryBuffer[pitchHistoryBuffer.length - 1] = median;
  }

  // 4. Return the simple moving average of the validated window
  const sum = pitchHistoryBuffer.reduce((acc, val) => acc + val, 0);
  return sum / pitchHistoryBuffer.length;
}

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
  const [micLabel, setMicLabel] = useState<string | null>(null);

  const callbackRef = useRef(onMetricsUpdate);
  callbackRef.current = onMetricsUpdate;

  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const hpfRef = useRef<BiquadFilterNode | null>(null);
  const lpfRef = useRef<BiquadFilterNode | null>(null);
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
    const rawHz = pitch.isVoiced ? pitch.frequencyHz : 0;
    const smoothedHz = getSmoothedPitch(rawHz);

    const snapshot: VocalMetrics = {
      volumeDb: Math.round(volumeDb * 10) / 10,
      frequencyHz: Math.round(smoothedHz * 10) / 10,
      pitchConfidence: pitch.confidence,
      clarity: pitch.clarity,
      isVoiced: smoothedHz > 0,
      noteName: smoothedHz > 0 ? pitch.noteName : "—",
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

        // High-pass filter (cutoff 80Hz) to remove sub-bass rumblings
        const hpf = audioCtx.createBiquadFilter();
        hpf.type = "highpass";
        hpf.frequency.value = 80;

        // Low-pass filter (cutoff 800Hz) to isolate voice fundamental & ignore sibilants
        const lpf = audioCtx.createBiquadFilter();
        lpf.type = "lowpass";
        lpf.frequency.value = 800;

        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = fftSize;
        analyser.smoothingTimeConstant = 0; // raw time domain buffer is required for pitch detection

        // Connect chain: Mic Source -> Gain -> HPF -> LPF -> Analyser
        source.connect(gain);
        gain.connect(hpf);
        hpf.connect(lpf);
        lpf.connect(analyser);

        audioCtxRef.current = audioCtx;
        gainRef.current = gain;
        analyserRef.current = analyser;
        sourceRef.current = source;
        hpfRef.current = hpf;
        lpfRef.current = lpf;
        streamRef.current = stream;
        setAnalyserNode(analyser);

        const track = stream.getAudioTracks()[0];
        setMicLabel(track ? track.label : "Default Microphone");

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
    hpfRef.current?.disconnect();
    lpfRef.current?.disconnect();
    analyserRef.current?.disconnect();

    if (ownsStreamRef.current) {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    }

    audioCtxRef.current?.close();

    audioCtxRef.current = null;
    gainRef.current = null;
    analyserRef.current = null;
    sourceRef.current = null;
    hpfRef.current = null;
    lpfRef.current = null;
    streamRef.current = null;
    ownsStreamRef.current = false;
    setAnalyserNode(null);

    setIsActive(false);
    setMetrics(EMPTY_METRICS);
    setMicLabel(null);
    pitchHistoryBuffer.length = 0;
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

  return { isActive, metrics, analyserNode, error, start, stop, micLabel };
}
