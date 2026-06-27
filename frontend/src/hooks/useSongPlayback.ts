"use client";

import { useCallback, useEffect, useRef } from "react";

export interface UseSongPlaybackOptions {
  src: string;
  enabled: boolean;
  isPaused: boolean;
}

export interface UseSongPlaybackReturn {
  getCurrentTime: () => number;
  start: () => Promise<void>;
  stop: () => void;
  isPlaying: boolean;
}

export function useSongPlayback(
  options: UseSongPlaybackOptions
): UseSongPlaybackReturn {
  const { src, enabled, isPaused } = options;

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const isPlayingRef = useRef(false);

  const stop = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.src = "";
      audioRef.current = null;
    }
    isPlayingRef.current = false;
  }, []);

  const getCurrentTime = useCallback(() => {
    return audioRef.current?.currentTime ?? 0;
  }, []);

  const start = useCallback(async () => {
    stop();

    const audio = new Audio(src);
    audio.preload = "auto";
    audioRef.current = audio;
    isPlayingRef.current = true;

    audio.volume = enabled ? 0.85 : 0;

    try {
      await audio.play();
    } catch {
      isPlayingRef.current = false;
    }
  }, [src, enabled, stop]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !isPlayingRef.current) return;

    if (isPaused) {
      audio.pause();
    } else {
      audio.play().catch(() => {});
    }
  }, [isPaused]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = enabled ? 0.85 : 0;
  }, [enabled]);

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
