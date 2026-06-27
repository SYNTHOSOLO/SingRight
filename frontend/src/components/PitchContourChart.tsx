"use client";

import { useEffect, useRef } from "react";
import type { SongBundle, SyllableAnnotation } from "@/lib/songs/types";
import { PITCH_WARN_CENTS } from "@/lib/songs/pitch";

interface PitchContourChartProps {
  song: SongBundle;
  elapsedSec: number;
  livePitchHz: number;
  activeSyllable: SyllableAnnotation | null;
  pitchDeltaCents: number;
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
}: PitchContourChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const traceRef = useRef<TracePoint[]>([]);

  useEffect(() => {
    if (livePitchHz > 0) {
      traceRef.current.push({ t: elapsedSec, hz: livePitchHz });
      const cutoff = elapsedSec - TRACE_WINDOW_SEC;
      traceRef.current = traceRef.current.filter((p) => p.t >= cutoff);
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
    const minHz = 200;
    const maxHz = 520;

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
      const y = yForHz(s.expectedHz);
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

    // Live trace
    const trace = traceRef.current;
    if (trace.length > 1) {
      ctx.strokeStyle = "rgba(34, 211, 238, 0.9)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      trace.forEach((p, i) => {
        const x = xForTime(p.t);
        const y = yForHz(p.hz);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
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
  }, [song, elapsedSec, livePitchHz, activeSyllable, pitchDeltaCents]);

  return (
    <canvas
      ref={canvasRef}
      className="h-32 w-full rounded-lg bg-black/20"
      aria-label="Pitch contour chart"
    />
  );
}
