"use client";

import { useEffect, useRef } from "react";
import type { SongBundle, SyllableAnnotation } from "@/lib/songs/types";
import { PITCH_WARN_CENTS, shiftHz } from "@/lib/songs/pitch";

interface PitchContourChartProps {
  song: SongBundle;
  elapsedSec: number;
  livePitchHz: number;
  activeSyllable: SyllableAnnotation | null;
  pitchDeltaCents: number;
  keyShiftSemitones?: number;
}

interface TracePoint {
  t: number;
  hz: number;
}

const TRACE_WINDOW_SEC = 5;

export default function PitchContourChart({
  song,
  elapsedSec,
  livePitchHz,
  activeSyllable,
  pitchDeltaCents,
  keyShiftSemitones = 0,
}: PitchContourChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const traceRef = useRef<TracePoint[]>([]);

  useEffect(() => {
    if (livePitchHz > 0) {
      traceRef.current.push({ t: elapsedSec, hz: livePitchHz });
      const cutoff = elapsedSec - TRACE_WINDOW_SEC;
      traceRef.current = traceRef.current.filter((p) => p.t >= cutoff);
    } else {
      // Clear trace immediately on silence to avoid drawing connecting lines
      traceRef.current = [];
    }
  }, [elapsedSec, livePitchHz]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    const duration = song.durationSec;
    const minHz = shiftHz(200, keyShiftSemitones);
    const maxHz = shiftHz(520, keyShiftSemitones);

    const xForTime = (t: number) => (t / duration) * w;
    const yForHz = (hz: number) =>
      h - ((hz - minHz) / (maxHz - minHz)) * h;

    ctx.clearRect(0, 0, w, h);

    // Reference step curve
    ctx.strokeStyle = "rgba(139, 92, 246, 0.35)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const s of song.syllables) {
      const x1 = xForTime(s.start);
      const x2 = xForTime(s.end);
      const y = yForHz(shiftHz(s.expectedHz, keyShiftSemitones));
      ctx.moveTo(x1, y);
      ctx.lineTo(x2, y);
    }
    ctx.stroke();

    // Active syllable highlight
    if (activeSyllable) {
      const x1 = xForTime(activeSyllable.start);
      const x2 = xForTime(activeSyllable.end);
      const warn =
        Math.abs(pitchDeltaCents) > PITCH_WARN_CENTS && livePitchHz > 0;
      ctx.fillStyle = warn
        ? "rgba(244, 63, 94, 0.15)"
        : "rgba(52, 211, 153, 0.12)";
      ctx.fillRect(x1, 0, x2 - x1, h);
    }

    // Live trace with gap detection
    const trace = traceRef.current;
    const MAX_GAP_SEC = 0.15;
    if (trace.length > 1) {
      ctx.strokeStyle = "rgba(34, 211, 238, 0.9)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      let first = true;
      for (let i = 0; i < trace.length; i++) {
        const p = trace[i];
        if (i > 0 && p.t - trace[i - 1].t > MAX_GAP_SEC) {
          ctx.stroke();
          ctx.beginPath();
          first = true;
        }
        const x = xForTime(p.t);
        const y = yForHz(p.hz);
        if (first) {
          ctx.moveTo(x, y);
          first = false;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }

    // Playhead
    const playX = xForTime(elapsedSec);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.5)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(playX, 0);
    ctx.lineTo(playX, h);
    ctx.stroke();
  }, [song, elapsedSec, livePitchHz, activeSyllable, pitchDeltaCents, keyShiftSemitones]);

  return (
    <canvas
      ref={canvasRef}
      className="h-32 w-full rounded-lg bg-black/20"
      aria-label="Pitch contour chart"
    />
  );
}
