"use client";

import { useEffect, useRef, type MutableRefObject } from "react";
import type { SongBundle, SyllableAnnotation, SyllableResult } from "@/lib/songs/types";
import { PITCH_CLEAR_CENTS, PITCH_WARN_CENTS } from "@/lib/songs/pitch";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface PitchLaneProps {
  song: SongBundle;
  elapsedRef: MutableRefObject<number>;
  livePitchHz: number;
  activeSyllable: SyllableAnnotation | null;
  completedResults: SyllableResult[];
  keyShiftSemitones?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WINDOW_SEC = 6;
const PLAYHEAD_RATIO = 0.22;
const BOX_HEIGHT = 32;
const TRAIL_MAX = 60;
const PAD_Y = 28;

const MIN_HZ = 80;
const MAX_HZ = 700;
const LOG_MIN = Math.log2(MIN_HZ);
const LOG_MAX = Math.log2(MAX_HZ);

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

const COLOR_HYST_CENTS = 12;

type PitchColorState = "ok" | "warn" | "bad" | "silent";

function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function midiToNoteName(midi: number): string {
  const note = NOTE_NAMES[midi % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${note}${octave}`;
}

function shiftHz(hz: number, semitones: number): number {
  return hz * Math.pow(2, semitones / 12);
}

function nearestOctaveCents(actualHz: number, targetHz: number): number {
  let best = Infinity;
  for (let o = -3; o <= 3; o++) {
    const shifted = targetHz * Math.pow(2, o);
    const cents = Math.abs(1200 * Math.log2(actualHz / shifted));
    if (cents < best) best = cents;
  }
  return best;
}

function nextPitchColorState(
  cents: number,
  prev: PitchColorState
): PitchColorState {
  if (cents === Infinity) return "silent";

  if (prev === "ok") {
    if (cents <= PITCH_CLEAR_CENTS + COLOR_HYST_CENTS) return "ok";
    if (cents <= PITCH_WARN_CENTS + COLOR_HYST_CENTS) return "warn";
    return "bad";
  }
  if (prev === "warn") {
    if (cents <= PITCH_CLEAR_CENTS) return "ok";
    if (cents <= PITCH_WARN_CENTS + COLOR_HYST_CENTS) return "warn";
    return "bad";
  }
  if (prev === "bad") {
    if (cents <= PITCH_CLEAR_CENTS) return "ok";
    if (cents <= PITCH_WARN_CENTS) return "warn";
    return "bad";
  }

  if (cents <= PITCH_CLEAR_CENTS) return "ok";
  if (cents <= PITCH_WARN_CENTS) return "warn";
  return "bad";
}

function roundPx(n: number): number {
  return Math.round(n);
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

interface TrailPoint {
  t: number;
  hz: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function PitchLane({
  song,
  elapsedRef,
  livePitchHz,
  activeSyllable,
  completedResults,
  keyShiftSemitones = 0,
}: PitchLaneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trailRef = useRef<TrailPoint[]>([]);
  const pitchColorRef = useRef<PitchColorState>("silent");
  const activeKeyRef = useRef("");
  const lastTrailSampleRef = useRef({ t: -1, hz: 0 });

  const propsRef = useRef({
    song,
    livePitchHz,
    activeSyllable,
    completedResults,
    keyShiftSemitones,
  });
  propsRef.current = {
    song,
    livePitchHz,
    activeSyllable,
    completedResults,
    keyShiftSemitones,
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const sizeRef = { w: 0, h: 0, dpr: 1 };

    const syncCanvasSize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));
      if (w === sizeRef.w && h === sizeRef.h && dpr === sizeRef.dpr) return;

      sizeRef.w = w;
      sizeRef.h = h;
      sizeRef.dpr = dpr;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
    };

    const resizeObserver = new ResizeObserver(syncCanvasSize);
    resizeObserver.observe(canvas);
    syncCanvasSize();

    let rafId = 0;

    const draw = () => {
      syncCanvasSize();
      const { w, h, dpr } = sizeRef;
      if (w === 0 || h === 0) {
        rafId = requestAnimationFrame(draw);
        return;
      }

      const {
        song: currentSong,
        livePitchHz: pitchHz,
        activeSyllable: active,
        completedResults: results,
        keyShiftSemitones: shift,
      } = propsRef.current;

      const elapsedSec = elapsedRef.current;

      if (active) {
        const activeKey = `${active.start}-${active.token}`;
        if (activeKey !== activeKeyRef.current) {
          activeKeyRef.current = activeKey;
          pitchColorRef.current = "silent";
        }
      } else {
        activeKeyRef.current = "";
        pitchColorRef.current = "silent";
      }

      if (pitchHz > 0) {
        const last = lastTrailSampleRef.current;
        if (
          Math.abs(elapsedSec - last.t) > 0.02 ||
          Math.abs(pitchHz - last.hz) > 0.5
        ) {
          trailRef.current.push({ t: elapsedSec, hz: pitchHz });
          lastTrailSampleRef.current = { t: elapsedSec, hz: pitchHz };
          if (trailRef.current.length > TRAIL_MAX) {
            trailRef.current = trailRef.current.slice(-TRAIL_MAX);
          }
        }
      } else if (trailRef.current.length > 4) {
        trailRef.current = trailRef.current.slice(-4);
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const W = w;
      const H = h;
      const RULER_W = 36;
      const LANE_W = W - RULER_W;

      const yForHz = (hz: number): number => {
        const clamped = Math.max(MIN_HZ, Math.min(MAX_HZ, hz));
        return PAD_Y + (1 - (Math.log2(clamped) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * (H - PAD_Y * 2);
      };

      const xForTime = (t: number): number =>
        RULER_W + (((t - elapsedSec) / WINDOW_SEC) + PLAYHEAD_RATIO) * LANE_W;

      const playheadX = roundPx(RULER_W + PLAYHEAD_RATIO * LANE_W);

      ctx.fillStyle = "#07070f";
      ctx.fillRect(0, 0, W, H);

      ctx.fillStyle = "#0d0d1a";
      ctx.fillRect(0, 0, RULER_W, H);

      for (let midi = 43; midi <= 79; midi++) {
        const noteHz = midiToHz(midi);
        if (noteHz < MIN_HZ || noteHz > MAX_HZ) continue;
        const y = roundPx(yForHz(noteHz)) + 0.5;
        const noteName = midiToNoteName(midi);
        const isNatural = !noteName.includes("#");

        ctx.strokeStyle = isNatural ? "rgba(255,255,255,0.07)" : "rgba(255,255,255,0.025)";
        ctx.lineWidth = isNatural ? 1 : 0.5;
        ctx.beginPath();
        ctx.moveTo(RULER_W, y);
        ctx.lineTo(W, y);
        ctx.stroke();

        if (isNatural) {
          ctx.fillStyle = "rgba(255,255,255,0.30)";
          ctx.font = "bold 9px Inter, system-ui, sans-serif";
          ctx.textAlign = "right";
          ctx.textBaseline = "middle";
          ctx.fillText(noteName, RULER_W - 3, y);

          ctx.strokeStyle = "rgba(255,255,255,0.18)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(RULER_W - 2, y);
          ctx.lineTo(RULER_W, y);
          ctx.stroke();
        }
      }

      ctx.strokeStyle = "rgba(255,255,255,0.1)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(RULER_W + 0.5, 0);
      ctx.lineTo(RULER_W + 0.5, H);
      ctx.stroke();

      const grad = ctx.createLinearGradient(RULER_W, 0, playheadX, 0);
      grad.addColorStop(0, "rgba(0,0,0,0.5)");
      grad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = grad;
      ctx.fillRect(RULER_W, 0, playheadX - RULER_W, H);

      const resultMap = new Map<string, SyllableResult>();
      for (const r of results) resultMap.set(`${r.start}-${r.token}`, r);

      const leftTime = elapsedSec - PLAYHEAD_RATIO * WINDOW_SEC - 0.5;
      const rightTime = elapsedSec + (1 - PLAYHEAD_RATIO) * WINDOW_SEC + 0.5;

      for (const syl of currentSong.syllables) {
        if (syl.end < leftTime || syl.start > rightTime) continue;

        const x1 = xForTime(syl.start);
        const x2 = xForTime(syl.end);
        const boxW = Math.max(roundPx(x2 - x1) - 3, 6);
        const cy = roundPx(yForHz(shiftHz(syl.expectedHz, shift)));
        const bx = roundPx(x1) + 1;
        const by = cy - BOX_HEIGHT / 2;

        const isActive =
          active !== null &&
          active.start === syl.start &&
          active.token === syl.token;

        const result = resultMap.get(`${syl.start}-${syl.token}`);
        const shiftedExpHz = shiftHz(syl.expectedHz, shift);
        const liveCents =
          pitchHz > 0 ? nearestOctaveCents(pitchHz, shiftedExpHz) : Infinity;

        let fillColor: string;
        let strokeColor: string;
        let shadowColor: string | null = null;

        if (isActive) {
          const colorState = nextPitchColorState(liveCents, pitchColorRef.current);
          pitchColorRef.current = colorState;

          if (colorState === "silent") {
            fillColor = "rgba(139,92,246,0.22)";
            strokeColor = "rgba(167,139,250,0.9)";
            shadowColor = "rgba(139,92,246,0.5)";
          } else if (colorState === "ok") {
            fillColor = "rgba(52,211,153,0.28)";
            strokeColor = "rgba(52,211,153,1.0)";
            shadowColor = "rgba(52,211,153,0.6)";
          } else if (colorState === "bad") {
            fillColor = "rgba(251,113,133,0.22)";
            strokeColor = "rgba(251,113,133,0.95)";
            shadowColor = "rgba(251,113,133,0.45)";
          } else {
            fillColor = "rgba(251,191,36,0.22)";
            strokeColor = "rgba(251,191,36,0.9)";
            shadowColor = "rgba(251,191,36,0.45)";
          }
        } else {
          if (result) {
            switch (result.issue) {
              case "ok":
                fillColor = "rgba(52,211,153,0.16)";
                strokeColor = "rgba(52,211,153,0.45)";
                break;
              case "quiet":
                fillColor = "rgba(251,191,36,0.13)";
                strokeColor = "rgba(251,191,36,0.38)";
                break;
              case "missed":
                fillColor = "rgba(80,80,100,0.1)";
                strokeColor = "rgba(100,100,130,0.28)";
                break;
              default:
                fillColor = "rgba(251,113,133,0.16)";
                strokeColor = "rgba(251,113,133,0.4)";
                break;
            }
          } else if (syl.end < elapsedSec) {
            fillColor = "rgba(80,80,100,0.1)";
            strokeColor = "rgba(100,100,130,0.25)";
          } else {
            fillColor = "rgba(139,92,246,0.1)";
            strokeColor = "rgba(139,92,246,0.32)";
          }
        }

        ctx.shadowColor = shadowColor ?? "transparent";
        ctx.shadowBlur = shadowColor ? 12 : 0;
        ctx.fillStyle = fillColor;
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = isActive ? 2 : 1.5;
        roundRect(ctx, bx, by, boxW, BOX_HEIGHT, 7);
        ctx.fill();
        ctx.stroke();
        ctx.shadowBlur = 0;

        if (boxW > 14) {
          const words = currentSong.lyricLines[syl.lyricLineIdx]?.split(" ") ?? [];
          const word = words[syl.syllableInLineIdx] ?? syl.token;
          const fontSize = Math.max(9, Math.min(13, boxW / Math.max(word.length, 1) * 1.1));

          ctx.font = `${isActive ? 700 : 600} ${fontSize}px Inter, system-ui, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillStyle = isActive
            ? "rgba(255,255,255,0.97)"
            : result
              ? "rgba(255,255,255,0.6)"
              : "rgba(255,255,255,0.45)";

          ctx.save();
          ctx.beginPath();
          ctx.rect(bx + 2, by, boxW - 4, BOX_HEIGHT);
          ctx.clip();
          ctx.fillText(word, bx + boxW / 2, cy);
          ctx.restore();
        }
      }

      const trail = trailRef.current;
      if (trail.length > 1) {
        for (let i = 1; i < trail.length; i++) {
          const p0 = trail[i - 1];
          const p1 = trail[i];
          const alpha = (i / trail.length) * 0.65;
          ctx.strokeStyle = `rgba(34,211,238,${alpha.toFixed(2)})`;
          ctx.lineWidth = 2.5;
          ctx.lineCap = "round";
          ctx.shadowColor = "rgba(34,211,238,0.35)";
          ctx.shadowBlur = 5;
          ctx.beginPath();
          ctx.moveTo(roundPx(xForTime(p0.t)), roundPx(yForHz(p0.hz)));
          ctx.lineTo(roundPx(xForTime(p1.t)), roundPx(yForHz(p1.hz)));
          ctx.stroke();
        }
        ctx.shadowBlur = 0;
      }

      if (pitchHz > 0) {
        const dotX = playheadX;
        const dotY = roundPx(yForHz(pitchHz));
        const R = 10;

        let dotColor = "#22d3ee";
        if (active) {
          const shiftedTarget = shiftHz(active.expectedHz, shift);
          const cents = nearestOctaveCents(pitchHz, shiftedTarget);
          const dotState = nextPitchColorState(cents, pitchColorRef.current);
          if (dotState === "ok") dotColor = "#34d399";
          else if (dotState === "warn") dotColor = "#fbbf24";
          else if (dotState === "bad") dotColor = "#fb7185";
        }

        ctx.shadowColor = dotColor;
        ctx.shadowBlur = 22;
        ctx.beginPath();
        ctx.arc(dotX, dotY, R + 5, 0, Math.PI * 2);
        ctx.fillStyle = `${dotColor}30`;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(dotX, dotY, R, 0, Math.PI * 2);
        ctx.fillStyle = dotColor;
        ctx.fill();
        ctx.shadowBlur = 0;

        ctx.beginPath();
        ctx.arc(dotX - R * 0.28, dotY - R * 0.28, R * 0.32, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,255,255,0.65)";
        ctx.fill();

        ctx.fillStyle = `${dotColor}cc`;
        ctx.font = "bold 10px Inter, system-ui, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(`${Math.round(pitchHz)} Hz`, dotX + R + 6, dotY);
      }

      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = "rgba(255,255,255,0.18)";
      ctx.lineWidth = 1;
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.moveTo(playheadX + 0.5, 0);
      ctx.lineTo(playheadX + 0.5, H);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = "rgba(255,255,255,0.22)";
      ctx.font = "bold 9px Inter, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText("NOW", playheadX, 4);

      rafId = requestAnimationFrame(draw);
    };

    rafId = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
    };
  }, [elapsedRef]);

  return (
    <canvas
      ref={canvasRef}
      className="h-full min-h-[140px] w-full rounded-xl"
      aria-label="Pitch lane — syllable pitch targets"
    />
  );
}
