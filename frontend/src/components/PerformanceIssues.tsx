"use client";

import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { SyllableResult } from "@/lib/songs/types";
import {
  getSessionSummary,
  isMajorIssue,
} from "@/hooks/useSyllableTracker";

interface PerformanceIssuesProps {
  completedResults: SyllableResult[];
}

function formatIssue(result: SyllableResult): string {
  switch (result.issue) {
    case "sharp":
      return `${Math.round(result.pitchErrorCents)}¢ sharp`;
    case "flat":
      return `${Math.round(Math.abs(result.pitchErrorCents))}¢ flat`;
    case "quiet":
      return "too quiet";
    case "missed":
      return "missed / no pitch detected";
    default:
      return "on pitch";
  }
}

export default function PerformanceIssues({
  completedResults,
}: PerformanceIssuesProps) {
  const problems = completedResults.filter((r) => r.issue !== "ok");
  const summary = getSessionSummary(completedResults);

  return (
    <section className="glass-card glow-cyan flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[var(--color-text-secondary)]">
          Performance Analysis
        </h3>
        {completedResults.length > 0 && (
          <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-400">
            {summary.onPitchPct}% on pitch
          </span>
        )}
      </div>

      {completedResults.length > 0 && (
        <div className="flex flex-wrap gap-2 text-xs text-[var(--color-text-secondary)]">
          <span>Avg error: {summary.avgCentsError}¢</span>
          {summary.worstSyllable && (
            <span>Needs work: {summary.worstSyllable.replace(/_/g, "·")}</span>
          )}
        </div>
      )}

      <div className="max-h-40 space-y-2 overflow-y-auto">
        {problems.length === 0 && completedResults.length === 0 && (
          <p className="text-xs text-[var(--color-text-secondary)]">
            Sing along to see syllable-level feedback here.
          </p>
        )}
        {problems.length === 0 && completedResults.length > 0 && (
          <div className="flex items-center gap-2 text-xs text-emerald-400">
            <CheckCircle2 className="h-3.5 w-3.5" />
            All scored syllables on target so far.
          </div>
        )}
        {problems.map((result, idx) => (
          <div
            key={`${result.token}-${result.start}-${idx}`}
            className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
              isMajorIssue(result.issue)
                ? "border-rose-500/30 bg-rose-500/5"
                : "border-amber-500/30 bg-amber-500/5"
            }`}
          >
            <AlertTriangle
              className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                isMajorIssue(result.issue) ? "text-rose-400" : "text-amber-400"
              }`}
            />
            <div>
              <span className="font-medium text-[var(--color-text-primary)]">
                {result.token.replace(/_/g, "·")}
              </span>
              <span className="text-[var(--color-text-secondary)]">
                {" "}
                — {formatIssue(result)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
