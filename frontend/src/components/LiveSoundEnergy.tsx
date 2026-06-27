"use client";

import { Activity, Zap } from "lucide-react";
import type { VocalMetrics } from "@/hooks/useVocalAnalyzer";
import { computeLiveEnergy } from "@/lib/audio/notes";

interface LiveSoundEnergyProps {
  metrics: VocalMetrics;
  targetNote?: string | null;
  isActive: boolean;
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
}: LiveSoundEnergyProps) {
  const energy = computeLiveEnergy(metrics);
  const energyGradient = energyColor(energy);

  return (
    <section className="glass-card overflow-hidden">
      <div className="flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-5 py-3">
        <Zap className="h-4 w-4 text-amber-400" />
        <h2 className="text-sm font-semibold text-[var(--color-text-secondary)]">
          Live Sound
        </h2>
        <span className="ml-auto font-mono text-xs text-[var(--color-text-muted)]">
          {isActive ? `${energy}% energy` : "—"}
        </span>
      </div>

      <div className="px-5 py-4 space-y-4">
        {/* Big note readout */}
        <div className="flex items-center gap-4">
          <div
            className={`flex h-20 w-20 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-gradient-to-br ${
              metrics.isVoiced
                ? "from-violet-600/40 to-fuchsia-600/30 shadow-lg shadow-violet-600/20"
                : "from-white/5 to-white/5"
            }`}
          >
            <span
              className={`text-2xl font-black tracking-tight ${
                metrics.isVoiced ? "text-white" : "text-zinc-600"
              }`}
            >
              {metrics.isVoiced && metrics.noteName !== "—"
                ? metrics.noteName.replace("#", "♯")
                : "—"}
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
              Your pitch
            </p>
            <p className="truncate font-mono text-lg font-bold text-white">
              {metrics.frequencyHz > 0
                ? `${metrics.frequencyHz.toFixed(1)} Hz`
                : isActive
                ? "No pitch detected"
                : "Mic off"}
            </p>
            {targetNote && (
              <p className="mt-0.5 text-xs text-cyan-400">
                Target: {targetNote.replace("#", "♯")}
              </p>
            )}
          </div>
        </div>

        {/* Energy bar */}
        <div>
          <div className="mb-1 flex items-center justify-between text-xs">
            <span className="flex items-center gap-1 text-[var(--color-text-muted)]">
              <Activity className="h-3 w-3" /> Vocal energy
            </span>
            <span className="font-mono text-[var(--color-text-muted)]">
              {energy}%
            </span>
          </div>
          <div className="h-4 w-full overflow-hidden rounded-full bg-white/5">
            <div
              className={`h-full rounded-full bg-gradient-to-r transition-all duration-150 ${energyGradient}`}
              style={{ width: `${energy}%` }}
            />
          </div>
        </div>

        {/* Sub-metrics */}
        <div className="grid grid-cols-3 gap-2 text-center text-xs">
          <div className="rounded-lg bg-white/5 px-2 py-2">
            <p className="text-[var(--color-text-muted)]">Volume</p>
            <p className="font-mono font-semibold text-emerald-400">
              {metrics.volumeDb.toFixed(0)} dB
            </p>
          </div>
          <div className="rounded-lg bg-white/5 px-2 py-2">
            <p className="text-[var(--color-text-muted)]">Tone clarity</p>
            <p
              className={`font-mono font-semibold ${
                metrics.clarity > 0.3 ? "text-cyan-400" : "text-zinc-400"
              }`}
            >
              {(metrics.clarity * 100).toFixed(0)}%
            </p>
          </div>
          <div className="rounded-lg bg-white/5 px-2 py-2">
            <p className="text-[var(--color-text-muted)]">Pitch lock</p>
            <p
              className={`font-mono font-semibold ${
                metrics.pitchConfidence > 0.5 ? "text-violet-400" : "text-zinc-400"
              }`}
            >
              {(metrics.pitchConfidence * 100).toFixed(0)}%
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
