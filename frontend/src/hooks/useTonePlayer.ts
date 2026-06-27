"use client";

import { useCallback, useRef } from "react";

export interface ToneEvent {
  frequencyHz: number;
  durationMs: number;
  syllable?: string;
}

export interface UseTonePlayerReturn {
  playTone: (frequencyHz: number, durationMs?: number) => Promise<void>;
  playSequence: (events: ToneEvent[]) => Promise<void>;
  stop: () => void;
  isPlaying: boolean;
}

export function useTonePlayer(): UseTonePlayerReturn {
  const ctxRef = useRef<AudioContext | null>(null);
  const oscillatorsRef = useRef<OscillatorNode[]>([]);
  const isPlayingRef = useRef(false);

  const getCtx = useCallback(async () => {
    if (!ctxRef.current) {
      ctxRef.current = new AudioContext();
    }
    await ctxRef.current.resume();
    return ctxRef.current;
  }, []);

  const stop = useCallback(() => {
    oscillatorsRef.current.forEach((osc) => {
      try {
        osc.stop();
        osc.disconnect();
      } catch {
        // already stopped
      }
    });
    oscillatorsRef.current = [];
    isPlayingRef.current = false;
  }, []);

  const playTone = useCallback(
    async (frequencyHz: number, durationMs = 1200) => {
      stop();
      const ctx = await getCtx();
      isPlayingRef.current = true;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = frequencyHz;

      const now = ctx.currentTime;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.25, now + 0.05);
      gain.gain.setValueAtTime(0.25, now + durationMs / 1000 - 0.1);
      gain.gain.linearRampToValueAtTime(0, now + durationMs / 1000);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + durationMs / 1000 + 0.05);
      oscillatorsRef.current.push(osc);

      await new Promise((r) => setTimeout(r, durationMs + 80));
      isPlayingRef.current = false;
    },
    [getCtx, stop]
  );

  const playSequence = useCallback(
    async (events: ToneEvent[]) => {
      stop();
      isPlayingRef.current = true;

      for (const event of events) {
        await playTone(event.frequencyHz, event.durationMs);
        await new Promise((r) => setTimeout(r, 60));
      }

      isPlayingRef.current = false;
    },
    [playTone, stop]
  );

  return {
    playTone,
    playSequence,
    stop,
    isPlaying: isPlayingRef.current,
  };
}
