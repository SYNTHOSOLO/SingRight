"use client";

import { useEffect, useRef } from "react";
import type { SongBundle, SyllableAnnotation, SyllableResult } from "@/lib/songs/types";
import { PITCH_CLEAR_CENTS, PITCH_WARN_CENTS } from "@/lib/songs/pitch";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface PitchLaneProps {
  song: SongBundle;
  elapsedSec: number;
  livePitchHz: number;
  activeSyllable: SyllableAnnotation | null;
  pitchDeltaCents: number;
  completedResults: SyllableResult[];
  /** Semitones to shift target boxes down (positive = targets go down to meet the user's voice) */
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

// Dynamic bounds are calculated within the component body to prevent mushing

/** Musical note reference grid to show on the left ruler */
const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"] as const;

function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function midiToNoteName(midi: number): string {
  const note = NOTE_NAMES[midi % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${note}${octave}`;
}

/** Shift an Hz value by `semitones` */
function shiftHz(hz: number, semitones: number): number {
  return hz * Math.pow(2, semitones / 12);
}

/**
 * Find the smallest absolute cents deviation between actualHz and targetHz,
 * allowing ±3 octaves. This makes the dot green even when singing an octave lower.
 */
function nearestOctaveCents(actualHz: number, targetHz: number): number {
  let best = Infinity;
  for (let o = -3; o <= 3; o++) {
    const shifted = targetHz * Math.pow(2, o);
    const cents = Math.abs(1200 * Math.log2(actualHz / shifted));
    if (cents < best) best = cents;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Helper: draw a rounded rectangle path
// ---------------------------------------------------------------------------

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TrailPoint { t: number; hz: number; }

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function PitchLane({
  song,
  elapsedSec,
  livePitchHz,
  activeSyllable,
  pitchDeltaCents,
  completedResults,
  keyShiftSemitones = 0,
}: PitchLaneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trailRef = useRef<TrailPoint[]>([]);

  // Find song MIDI range dynamically to fit the notes nicely
  const midiPitches = song.syllables.map((s) => s.pitchMidi);
  const songMinMidi = midiPitches.length > 0 ? Math.min(...midiPitches) : 60;
  const songMaxMidi = midiPitches.length > 0 ? Math.max(...midiPitches) : 72;

  // Add 4 semitones margin below and above, and apply key shift
  const displayMinMidi = songMinMidi + keyShiftSemitones - 4;
  const displayMaxMidi = songMaxMidi + keyShiftSemitones + 4;

  const minHz = 440 * Math.pow(2, (displayMinMidi - 69) / 12);
  const maxHz = 440 * Math.pow(2, (displayMaxMidi - 69) / 12);
  const logMin = Math.log2(minHz);
  const logMax = Math.log2(maxHz);

  // ── Accumulate pitch trail points (folding octaves to make visualization clean) ──────────────────
  useEffect(() => {
    if (livePitchHz > 0) {
      let foldedHz = livePitchHz;
      if (activeSyllable) {
        const shiftedTarget = shiftHz(activeSyllable.expectedHz, keyShiftSemitones);
        let bestDiff = Infinity;
        let bestPitch = livePitchHz;
        for (let o = -3; o <= 3; o++) {
          const candidate = livePitchHz * Math.pow(2, o);
          const diff = Math.abs(Math.log2(candidate / shiftedTarget));
          if (diff < bestDiff) {
            bestDiff = diff;
            bestPitch = candidate;
          }
        }
        foldedHz = bestPitch;
      }
      trailRef.current.push({ t: elapsedSec, hz: foldedHz });
      if (trailRef.current.length > TRAIL_MAX) trailRef.current = trailRef.current.slice(-TRAIL_MAX);
    } else {
      // Immediately wipe the trail on silence — avoids lingering vertical spikes
      trailRef.current = [];
    }
  }, [elapsedSec, livePitchHz, activeSyllable, keyShiftSemitones]);

  // ── Main draw effect ─────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const W = rect.width;
    const H = rect.height;

    // Left ruler width
    const RULER_W = 36;
    const LANE_W = W - RULER_W;

    // ── Coordinate helpers ─────────────────────────────────────────────────
    const yForHz = (hz: number): number => {
      const clamped = Math.max(minHz, Math.min(maxHz, hz));
      return PAD_Y + (1 - (Math.log2(clamped) - logMin) / (logMax - logMin)) * (H - PAD_Y * 2);
    };

    /** Map a song time (sec) to canvas X, starting after the ruler */
    const xForTime = (t: number): number =>
      RULER_W + (((t - elapsedSec) / WINDOW_SEC) + PLAYHEAD_RATIO) * LANE_W;

    const playheadX = RULER_W + PLAYHEAD_RATIO * LANE_W;

    // ── Background ─────────────────────────────────────────────────────────
    ctx.fillStyle = "#07070f";
    ctx.fillRect(0, 0, W, H);

    // ── Pitch ruler (left side) ────────────────────────────────────────────
    ctx.fillStyle = "#0d0d1a";
    ctx.fillRect(0, 0, RULER_W, H);

    // Draw note name grid lines for key notes across the visible range
    for (let midi = displayMinMidi; midi <= displayMaxMidi; midi++) {
      const noteHz = midiToHz(midi);
      const y = yForHz(noteHz);
      const noteName = midiToNoteName(midi);
      const isNatural = !noteName.includes("#");

      // Grid line across full width
      ctx.strokeStyle = isNatural ? "rgba(255,255,255,0.07)" : "rgba(255,255,255,0.025)";
      ctx.lineWidth = isNatural ? 1 : 0.5;
      ctx.beginPath();
      ctx.moveTo(RULER_W, y);
      ctx.lineTo(W, y);
      ctx.stroke();

      // Ruler label — only draw natural notes
      if (isNatural) {
        ctx.fillStyle = "rgba(255,255,255,0.30)";
        ctx.font = "bold 9px Inter, system-ui, sans-serif";
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        ctx.fillText(noteName, RULER_W - 3, y);

        // Tick mark
        ctx.strokeStyle = "rgba(255,255,255,0.18)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(RULER_W - 2, y);
        ctx.lineTo(RULER_W, y);
        ctx.stroke();
      }
    }

    // Ruler right border
    ctx.strokeStyle = "rgba(255,255,255,0.1)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(RULER_W, 0);
    ctx.lineTo(RULER_W, H);
    ctx.stroke();

    // ── Past region dim overlay ────────────────────────────────────────────
    const grad = ctx.createLinearGradient(RULER_W, 0, playheadX, 0);
    grad.addColorStop(0, "rgba(0,0,0,0.5)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(RULER_W, 0, playheadX - RULER_W, H);

    // ── Build result lookup ────────────────────────────────────────────────
    const resultMap = new Map<string, SyllableResult>();
    for (const r of completedResults) resultMap.set(`${r.start}-${r.token}`, r);

    // ── Syllable boxes ─────────────────────────────────────────────────────
    const leftTime  = elapsedSec - PLAYHEAD_RATIO * WINDOW_SEC - 0.5;
    const rightTime = elapsedSec + (1 - PLAYHEAD_RATIO) * WINDOW_SEC + 0.5;

    for (const syl of song.syllables) {
      if (syl.end < leftTime || syl.start > rightTime) continue;

      // Apply key shift to display position
      const displayHz = shiftHz(syl.expectedHz, keyShiftSemitones);

      const x1 = xForTime(syl.start);
      const x2 = xForTime(syl.end);
      const boxW = Math.max(x2 - x1 - 3, 6);
      const cy = yForHz(displayHz);
      const bx = x1 + 1.5;
      const by = cy - BOX_HEIGHT / 2;

      const isActive =
        activeSyllable !== null &&
        activeSyllable.start === syl.start &&
        activeSyllable.token === syl.token;

      const result = resultMap.get(`${syl.start}-${syl.token}`);

      // ── Compute live accuracy against (possibly shifted) target ──────────
      const shiftedExpHz = shiftHz(syl.expectedHz, keyShiftSemitones);
      const liveCentsOctave = livePitchHz > 0 ? nearestOctaveCents(livePitchHz, shiftedExpHz) : Infinity;
      const isOnPitch = liveCentsOctave <= PITCH_CLEAR_CENTS;
      const isWarn    = liveCentsOctave > PITCH_WARN_CENTS;

      // ── Box colours ────────────────────────────────────────────────────
      let fillColor: string;
      let strokeColor: string;
      let shadowColor: string | null = null;

      if (isActive) {
        if (livePitchHz === 0) {
          fillColor = "rgba(139,92,246,0.22)"; strokeColor = "rgba(167,139,250,0.9)";
          shadowColor = "rgba(139,92,246,0.5)";
        } else if (isOnPitch) {
          fillColor = "rgba(52,211,153,0.28)"; strokeColor = "rgba(52,211,153,1.0)";
          shadowColor = "rgba(52,211,153,0.6)";
        } else if (isWarn) {
          fillColor = "rgba(251,113,133,0.22)"; strokeColor = "rgba(251,113,133,0.95)";
          shadowColor = "rgba(251,113,133,0.45)";
        } else {
          fillColor = "rgba(251,191,36,0.22)"; strokeColor = "rgba(251,191,36,0.9)";
          shadowColor = "rgba(251,191,36,0.45)";
        }
      } else if (result) {
        switch (result.issue) {
          case "ok":      fillColor = "rgba(52,211,153,0.16)"; strokeColor = "rgba(52,211,153,0.45)"; break;
          case "quiet":   fillColor = "rgba(251,191,36,0.13)"; strokeColor = "rgba(251,191,36,0.38)"; break;
          case "missed":  fillColor = "rgba(80,80,100,0.1)";   strokeColor = "rgba(100,100,130,0.28)"; break;
          default:        fillColor = "rgba(251,113,133,0.16)"; strokeColor = "rgba(251,113,133,0.4)"; break;
        }
      } else if (syl.end < elapsedSec) {
        fillColor = "rgba(80,80,100,0.1)"; strokeColor = "rgba(100,100,130,0.25)";
      } else {
        fillColor = "rgba(139,92,246,0.1)"; strokeColor = "rgba(139,92,246,0.32)";
      }

      if (shadowColor) { ctx.shadowColor = shadowColor; ctx.shadowBlur = 16; }
      else ctx.shadowBlur = 0;

      ctx.fillStyle = fillColor;
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = isActive ? 2 : 1.5;
      roundRect(ctx, bx, by, boxW, BOX_HEIGHT, 7);
      ctx.fill();
      ctx.stroke();
      ctx.shadowBlur = 0;

      // ── Word label ───────────────────────────────────────────────────
      if (boxW > 14) {
        const words = song.lyricLines[syl.lyricLineIdx]?.split(" ") ?? [];
        const word = words[syl.syllableInLineIdx] ?? syl.token;
        const fontSize = Math.max(9, Math.min(13, boxW / Math.max(word.length, 1) * 1.1));

        ctx.font = `${isActive ? 700 : 600} ${fontSize}px Inter, system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = isActive ? "rgba(255,255,255,0.97)" : result ? "rgba(255,255,255,0.6)" : "rgba(255,255,255,0.45)";

        ctx.save();
        ctx.beginPath();
        ctx.rect(bx + 2, by, boxW - 4, BOX_HEIGHT);
        ctx.clip();
        ctx.fillText(word, bx + boxW / 2, cy);
        ctx.restore();
      }
    }

    // ── Pitch trail ────────────────────────────────────────────────────────
    const trail = trailRef.current;
    const MAX_GAP_SEC = 0.15; // don't draw connecting lines across gaps > 150ms
    if (trail.length > 1) {
      for (let i = 1; i < trail.length; i++) {
        const p0 = trail[i - 1];
        const p1 = trail[i];
        // Skip segment if there's a time gap (user paused / stopped briefly)
        if (p1.t - p0.t > MAX_GAP_SEC) continue;
        const alpha = (i / trail.length) * 0.65;
        ctx.strokeStyle = `rgba(34,211,238,${alpha.toFixed(2)})`;
        ctx.lineWidth = 2.5;
        ctx.lineCap = "round";
        ctx.shadowColor = "rgba(34,211,238,0.35)";
        ctx.shadowBlur = 5;
        ctx.beginPath();
        ctx.moveTo(xForTime(p0.t), yForHz(p0.hz));
        ctx.lineTo(xForTime(p1.t), yForHz(p1.hz));
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
    }

    // ── Live pitch dot ─────────────────────────────────────────────────────
    if (livePitchHz > 0) {
      const dotX = playheadX;
      
      // Fold live pitch to display octave closest to target
      let displayLivePitchHz = livePitchHz;
      if (activeSyllable) {
        const shiftedTarget = shiftHz(activeSyllable.expectedHz, keyShiftSemitones);
        let bestDiff = Infinity;
        let bestPitch = livePitchHz;
        for (let o = -3; o <= 3; o++) {
          const candidate = livePitchHz * Math.pow(2, o);
          const diff = Math.abs(Math.log2(candidate / shiftedTarget));
          if (diff < bestDiff) {
            bestDiff = diff;
            bestPitch = candidate;
          }
        }
        displayLivePitchHz = bestPitch;
      }

      const dotY = yForHz(displayLivePitchHz);
      const R = 10;

      // Octave-insensitive colour: green if hitting any octave of active target
      let dotColor = "#22d3ee"; // cyan = no active target
      if (activeSyllable) {
        const shiftedTarget = shiftHz(activeSyllable.expectedHz, keyShiftSemitones);
        const cents = nearestOctaveCents(livePitchHz, shiftedTarget);
        if (cents <= PITCH_CLEAR_CENTS) dotColor = "#34d399";       // green ✓
        else if (cents <= PITCH_WARN_CENTS) dotColor = "#fbbf24";   // amber ⚠
        else dotColor = "#fb7185";                                    // red ✗
      }

      // Outer glow ring
      ctx.shadowColor = dotColor;
      ctx.shadowBlur = 22;
      ctx.beginPath();
      ctx.arc(dotX, dotY, R + 5, 0, Math.PI * 2);
      ctx.fillStyle = `${dotColor}30`;
      ctx.fill();

      // Core dot
      ctx.beginPath();
      ctx.arc(dotX, dotY, R, 0, Math.PI * 2);
      ctx.fillStyle = dotColor;
      ctx.fill();
      ctx.shadowBlur = 0;

      // Specular highlight
      ctx.beginPath();
      ctx.arc(dotX - R * 0.28, dotY - R * 0.28, R * 0.32, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.65)";
      ctx.fill();

      // Hz label next to dot
      ctx.fillStyle = `${dotColor}cc`;
      ctx.font = "bold 10px Inter, system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(`${Math.round(livePitchHz)} Hz`, dotX + R + 6, dotY);
    }

    // ── Playhead vertical line ─────────────────────────────────────────────
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 1;
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, H);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = "rgba(255,255,255,0.22)";
    ctx.font = "bold 9px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText("NOW", playheadX, 4);

  }, [song, elapsedSec, livePitchHz, activeSyllable, pitchDeltaCents, completedResults, keyShiftSemitones]);

  return (
    <canvas
      ref={canvasRef}
      className="h-64 w-full rounded-xl"
      aria-label="Pitch lane — syllable pitch targets"
    />
  );
}
