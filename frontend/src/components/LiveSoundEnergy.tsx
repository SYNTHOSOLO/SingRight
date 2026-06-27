"use client";

import { Activity, Zap } from "lucide-react";
import type { VocalMetrics } from "@/hooks/useVocalAnalyzer";
import { computeLiveEnergy } from "@/lib/audio/notes";

interface LiveSoundEnergyProps {
  metrics: VocalMetrics;
  targetNote?: string | null;
  isActive: boolean;
  isVolumeWarn?: boolean;
  targetPitchHz?: number;
  pitchDeltaCents?: number;
  isPitchWarn?: boolean;
}

function energyColor(pct: number): string {
  if (pct >= 70) return "from-emerald-400 to-cyan-400";
  if (pct >= 40) return "from-amber-400 to-orange-400";
  return "from-zinc-500 to-zinc-600";
}

export default function LiveSoundEnergy({
  metrics,
  targetNote,
  isActive,
  isVolumeWarn = false,
  targetPitchHz = 0,
  pitchDeltaCents = 0,
  isPitchWarn = false,
}: LiveSoundEnergyProps) {
  const energy = computeLiveEnergy(metrics);
  const energyGradient = energyColor(energy);

  return (
    <section className="glass-card shrink-0 overflow-hidden">
      <div className="flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-3 py-2">
        <Zap className="h-3.5 w-3.5 text-amber-400" />
        <h2 className="text-xs font-semibold text-[var(--color-text-secondary)]">
          Live Sound
        </h2>
        <span className="ml-auto font-mono text-[10px] text-[var(--color-text-muted)]">
          {isActive ? `${energy}%` : "—"}
        </span>
      </div>

      <div className="space-y-2 px-3 py-2">
        <div className="flex items-center gap-3">
          <div
            className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-gradient-to-br ${
              metrics.isVoiced
                ? "from-violet-600/40 to-fuchsia-600/30 shadow-lg shadow-violet-600/20"
                : "from-white/5 to-white/5"
            }`}
          >
            <span
              className={`text-xl font-black tracking-tight ${
                metrics.isVoiced ? "text-white" : "text-zinc-600"
              }`}
            >
              {metrics.isVoiced && metrics.noteName !== "—"
                ? metrics.noteName.replace("#", "♯")
                : "—"}
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
              Your pitch
            </p>
            <p className="truncate font-mono text-sm font-bold text-white">
              {metrics.frequencyHz > 0
                ? `${metrics.frequencyHz.toFixed(1)} Hz`
                : isActive
                ? "No pitch"
                : "Mic off"}
            </p>
            {targetNote && (
              <p className="text-[10px] text-cyan-400">
                Target: {targetNote.replace("#", "♯")}
                {targetPitchHz > 0 && ` · ${targetPitchHz.toFixed(0)} Hz`}
                {metrics.frequencyHz > 0 && targetPitchHz > 0 && (
                  <span className={isPitchWarn ? "text-rose-400" : "text-emerald-400"}>
                    {" "}
                    · Δ {Math.abs(pitchDeltaCents).toFixed(0)}¢
                    {pitchDeltaCents > 0 ? " sharp" : pitchDeltaCents < 0 ? " flat" : ""}
                  </span>
                )}
              </p>
            )}
          </div>
        </div>

        <div>
          <div className="mb-0.5 flex items-center justify-between text-[10px]">
            <span className="flex items-center gap-1 text-[var(--color-text-muted)]">
              <Activity className="h-2.5 w-2.5" /> Energy
            </span>
            <span className="font-mono text-[var(--color-text-muted)]">
              {energy}%
            </span>
          </div>
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-white/5">
            <div
              className={`h-full rounded-full bg-gradient-to-r transition-all duration-150 ${energyGradient}`}
              style={{ width: `${energy}%` }}
            />
          </div>
        </div>

        <div className="grid grid-cols-4 gap-1.5 text-center text-[10px]">
          <div className="rounded-md bg-white/5 px-1.5 py-1">
            <p className="text-[var(--color-text-muted)]">Vol</p>
            <p
              className={`font-mono font-semibold ${
                isVolumeWarn ? "text-amber-400" : "text-emerald-400"
              }`}
            >
              {metrics.volumeDb.toFixed(0)} dB
            </p>
          </div>
          <div className="rounded-md bg-white/5 px-1.5 py-1">
            <p className="text-[var(--color-text-muted)]">Clarity</p>
            <p
              className={`font-mono font-semibold ${
                metrics.clarity > 0.3 ? "text-cyan-400" : "text-zinc-400"
              }`}
            >
              {(metrics.clarity * 100).toFixed(0)}%
            </p>
          </div>
          <div className="rounded-md bg-white/5 px-1.5 py-1">
            <p className="text-[var(--color-text-muted)]">Lock</p>
            <p
              className={`font-mono font-semibold ${
                metrics.pitchConfidence > 0.5 ? "text-violet-400" : "text-zinc-400"
              }`}
            >
              {(metrics.pitchConfidence * 100).toFixed(0)}%
            </p>
          </div>
          <div className="rounded-md bg-white/5 px-1.5 py-1">
            <p className="text-[var(--color-text-muted)]">Voice</p>
            <p
              className={`font-semibold ${
                metrics.isVoiced ? "text-emerald-400" : "text-zinc-500"
              }`}
            >
              {metrics.isVoiced ? "On" : "Off"}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
