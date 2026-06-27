"use client";

import { useCallback, useEffect, useRef } from "react";

export interface UseKaraokeBackingTrackOptions {
  enabled: boolean;
  isPaused: boolean;
}

export interface UseKaraokeBackingTrackReturn {
  getCurrentTime: () => number;
  start: () => Promise<void>;
  stop: () => void;
  isPlaying: boolean;
}

const BPM = 60;
const BEATS_PER_BAR = 4;
const CHORD_TONES = [261.63, 329.63, 392.0, 523.25];

export function useKaraokeBackingTrack(
  options: UseKaraokeBackingTrackOptions
): UseKaraokeBackingTrackReturn {
  const { enabled, isPaused } = options;

  const audioCtxRef = useRef<AudioContext | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const clickGainRef = useRef<GainNode | null>(null);
  const oscillatorsRef = useRef<OscillatorNode[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef(0);
  const totalPausedRef = useRef(0);
  const pauseStartedRef = useRef<number | null>(null);
  const isPlayingRef = useRef(false);

  const cleanupNodes = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    oscillatorsRef.current.forEach((osc) => {
      try {
        osc.stop();
        osc.disconnect();
      } catch {
        // already stopped
      }
    });
    oscillatorsRef.current = [];
    clickGainRef.current?.disconnect();
    masterGainRef.current?.disconnect();
    clickGainRef.current = null;
    masterGainRef.current = null;
  }, []);

  const stop = useCallback(() => {
    cleanupNodes();
    audioCtxRef.current?.close();
    audioCtxRef.current = null;
    isPlayingRef.current = false;
    startTimeRef.current = 0;
    totalPausedRef.current = 0;
    pauseStartedRef.current = null;
  }, [cleanupNodes]);

  const startPad = useCallback((ctx: AudioContext, destination: AudioNode) => {
    const padGain = ctx.createGain();
    padGain.gain.value = 0.08;
    padGain.connect(destination);

    CHORD_TONES.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = i % 2 === 0 ? "sine" : "triangle";
      osc.frequency.value = freq;
      const toneGain = ctx.createGain();
      toneGain.gain.value = 0.25;
      osc.connect(toneGain);
      toneGain.connect(padGain);
      osc.start();
      oscillatorsRef.current.push(osc);
    });
  }, []);

  const playClick = useCallback(
    (ctx: AudioContext, destination: AudioNode, accent: boolean) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = accent ? 880 : 440;
      gain.gain.setValueAtTime(accent ? 0.15 : 0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.05);
      osc.connect(gain);
      gain.connect(destination);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.06);
    },
    []
  );

  const getCurrentTime = useCallback(() => {
    if (!isPlayingRef.current) return 0;
    const now = performance.now();
    if (pauseStartedRef.current !== null) {
      return (
        (pauseStartedRef.current - startTimeRef.current - totalPausedRef.current) /
        1000
      );
    }
    return (now - startTimeRef.current - totalPausedRef.current) / 1000;
  }, []);

  const start = useCallback(async () => {
    stop();

    const ctx = new AudioContext();
    await ctx.resume();

    const masterGain = ctx.createGain();
    masterGain.gain.value = enabled ? 0.9 : 0;
    masterGain.connect(ctx.destination);
    masterGainRef.current = masterGain;

    const clickGain = ctx.createGain();
    clickGain.gain.value = 0.5;
    clickGain.connect(masterGain);
    clickGainRef.current = clickGain;

    startPad(ctx, masterGain);

    audioCtxRef.current = ctx;
    startTimeRef.current = performance.now();
    totalPausedRef.current = 0;
    pauseStartedRef.current = null;
    isPlayingRef.current = true;

    let beat = 0;
    const beatIntervalMs = Math.round(60_000 / BPM);
    playClick(ctx, clickGain, true);

    intervalRef.current = setInterval(() => {
      if (!audioCtxRef.current || !isPlayingRef.current) return;
      if (pauseStartedRef.current !== null) return;
      beat = (beat + 1) % BEATS_PER_BAR;
      playClick(audioCtxRef.current, clickGainRef.current!, beat === 0);
    }, beatIntervalMs);
  }, [stop, startPad, playClick, enabled]);

  useEffect(() => {
    if (!isPlayingRef.current) return;
    const ctx = audioCtxRef.current;
    const master = masterGainRef.current;
    if (!ctx || !master) return;

    if (isPaused) {
      if (pauseStartedRef.current === null) {
        pauseStartedRef.current = performance.now();
        master.gain.setTargetAtTime(0, ctx.currentTime, 0.02);
      }
      return;
    }

    if (pauseStartedRef.current !== null) {
      totalPausedRef.current += performance.now() - pauseStartedRef.current;
      pauseStartedRef.current = null;
    }

    master.gain.setTargetAtTime(enabled ? 0.9 : 0, ctx.currentTime, 0.02);
  }, [isPaused, enabled]);

  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  return {
    getCurrentTime,
    start,
    stop,
    isPlaying: isPlayingRef.current,
  };
}
